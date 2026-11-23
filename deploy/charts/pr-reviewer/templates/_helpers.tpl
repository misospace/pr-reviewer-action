{{/*
Chart helpers for the #738 self-hosted chart.

The controller component is rendered through the bjw-s `common` library
(dependency `common`, pinned in Chart.yaml). Because the library reads
its API keys (`controllers`, `service`, `persistence`, `secrets`,
`serviceAccount`, `defaultPodOptions`, …) from top-level values, this
chart re-roots the render values on the `controller` section
(`pr-reviewer.component-values`) so operators use the familiar
app-template shapes nested under `controller`.

What the common library cannot express — the conditional env wiring that
maps values onto the controller's fail-closed environment contract
(src/controller/main.ts), conditional probes, and conditional rendered
Secrets/persistence — is injected in template land
(`pr-reviewer.controller.configure`) BEFORE the library renders.
*/}}

{{/*
The chart's resource name (mirrors the common library's name logic so
chart-injected objects and library-rendered objects never diverge).
*/}}
{{- define "pr-reviewer.name" -}}
{{- $name := .Values.nameOverride | default .Chart.Name -}}
{{- $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
The chart's fully-qualified resource name (mirrors the common library's
fullname logic: overrides win, then release-name containment, then
release-chart).
*/}}
{{- define "pr-reviewer.fullname" -}}
{{- $name := include "pr-reviewer.name" . -}}
{{- $fullname := .Values.fullnameOverride -}}
{{- if empty $fullname -}}
{{- if contains $name .Release.Name -}}
{{- $fullname = .Release.Name -}}
{{- else -}}
{{- $fullname = printf "%s-%s" .Release.Name $name -}}
{{- end -}}
{{- end -}}
{{- $fullname | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully-qualified resource name computed from explicit parts (for custom
templates that render outside the component-scoped context).
*/}}
{{- define "pr-reviewer.resource-fullname" -}}
{{- $name := index . "nameOverride" | default (index . "chartName") -}}
{{- $name = $name | trunc 63 | trimSuffix "-" -}}
{{- $releaseName := index . "releaseName" -}}
{{- $fullname := index . "fullnameOverride" -}}
{{- if empty $fullname -}}
{{- if contains $name $releaseName -}}
{{- $fullname = $releaseName -}}
{{- else -}}
{{- $fullname = printf "%s-%s" $releaseName $name -}}
{{- end -}}
{{- end -}}
{{- $fullname | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
#735 credential env name: exactly `credentialEnvName` in
src/controller/main.ts — the reference uppercased with every
non-alphanumeric character mapped to `_`. The subject is passed as
regexReplaceAll's explicit SECOND argument: piped usage appends the
piped value last, so `upper . | regexReplaceAll "[^A-Z0-9]" "_"`
matches the regex against the literal "_" replacement instead and
emits the reference verbatim (#1710: 'model-key' rendered
PR_REVIEWER_CREDENTIAL_MODEL-KEY, unreadable by the runtime).
*/}}
{{- define "pr-reviewer.credential-env-name" -}}
{{- printf "PR_REVIEWER_CREDENTIAL_%s" (regexReplaceAll "[^A-Z0-9]" (upper .) "_") -}}
{{- end -}}

{{/*
The component-scoped Values map: the component's section plus `global`,
ready to become a render context's `.Values` for the common library.
*/}}
{{- define "pr-reviewer.component-values" -}}
{{- $component := index . "component" -}}
{{- $root := index . "root" -}}
{{- $values := dict -}}
{{- /* the common library's own default values, which Helm merges in under
       the dependency key: bjw-s.common.values.init treats them as the base
       the component section is merged over */ -}}
{{- if hasKey $root.Values "common" -}}
{{- $_ := set $values "common" $root.Values.common -}}
{{- end -}}
{{- if hasKey $root.Values "global" -}}
{{- $_ := set $values "global" $root.Values.global -}}
{{- end -}}
{{- range $key, $value := (index $root.Values $component | default dict) -}}
{{- $_ := set $values $key $value -}}
{{- end -}}
{{- $values | toYaml -}}
{{- end -}}

{{/* Build the worker image from the chart-owned repository, release tag,
with an optional exact-byte digest pin. */}}
{{- define "pr-reviewer.worker-deployment-image" -}}
{{- $worker := .Values.workerExecutor -}}
{{- $repository := dig "image" "repository" "" $worker -}}
{{- if empty $repository -}}
{{- fail "workerExecutor.image.repository is required for Kubernetes mode (defaults to the chart's worker repository)" -}}
{{- end -}}
{{- $tag := dig "image" "tag" "" $worker | default .Chart.AppVersion -}}
{{- $digest := dig "image" "digest" "" $worker -}}
{{- if not (kindIs "string" $digest) -}}
{{- fail "workerExecutor.image.digest must match sha256:<64 lowercase hex characters>" -}}
{{- end -}}
{{- if and (ne $digest "") (not (regexMatch "^sha256:[0-9a-f]{64}$" $digest)) -}}
{{- fail "workerExecutor.image.digest must match sha256:<64 lowercase hex characters>" -}}
{{- end -}}
{{- if ne $digest "" -}}
{{- printf "%s:%s@%s" $repository $tag $digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end -}}

{{/* Serialize exactly the deployment-defaults grammar consumed by the runtime. */}}
{{- define "pr-reviewer.worker-deployment-defaults" -}}
{{- $worker := .Values.workerExecutor -}}
{{- dict "image" (include "pr-reviewer.worker-deployment-image" .) "ttlSecondsAfterFinished" $worker.ttlSecondsAfterFinished "resources" $worker.resources | toJson -}}
{{- end -}}

{{/* The controller container's environment: the complete mapping of chart
values onto the fail-closed env contract in src/controller/main.ts.
Signature: dict "ctx" <component context> "root" <chart root>
"workerExecutorKubernetes" <bool>. Conditional variables are genuinely
ABSENT when their feature is off. Secret material uses secretKeyRef. */}}
{{- define "pr-reviewer.controller.env" -}}
{{- $ctx := index . "ctx" -}}
{{- $root := index . "root" -}}
{{- $kubeExecutor := index . "workerExecutorKubernetes" -}}
{{- $v := $ctx.Values -}}
{{- $fullname := include "pr-reviewer.fullname" $ctx -}}
- name: PR_REVIEWER_INSTANCE_CONFIG
  value: /config/instance-config.yaml
{{- if $kubeExecutor }}
- name: PR_REVIEWER_KUBERNETES_DEPLOYMENT_DEFAULTS
  value: {{ include "pr-reviewer.worker-deployment-defaults" $root | quote }}
{{- end }}
- name: PR_REVIEWER_CONTROL_PLANE_URL
  valueFrom:
    secretKeyRef:
      name: {{ ternary (printf "%s-control-plane" $fullname) $v.controlPlaneUrlExistingSecret.name (empty $v.controlPlaneUrlExistingSecret.name) }}
      key: {{ default "dsn" $v.controlPlaneUrlExistingSecret.key }}
- name: PR_REVIEWER_DURABLE_STATE_DIR
  value: {{ $v.paths.durableStateDir | quote }}
- name: PR_REVIEWER_RUNS_ROOT
  value: {{ $v.paths.runsRoot | quote }}
- name: PR_REVIEWER_WORKSPACE_CACHE_ROOT
  value: {{ $v.paths.workspaceCacheRoot | quote }}
{{- if $v.webhook.enabled }}
- name: PR_REVIEWER_WEBHOOK_PORT
  value: {{ $v.webhook.port | quote }}
- name: PR_REVIEWER_WEBHOOK_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ ternary (printf "%s-webhook" $fullname) $v.webhook.existingSecret.name (empty $v.webhook.existingSecret.name) }}
      key: {{ default "webhook-secret" $v.webhook.existingSecret.key }}
{{- end }}
{{- if $v.admin.enabled }}
- name: PR_REVIEWER_ADMIN_PORT
  value: {{ $v.admin.port | quote }}
- name: PR_REVIEWER_ADMIN_BIND
  value: "0.0.0.0"
{{- if or (not (empty $v.admin.token)) (not (empty $v.admin.existingSecret.name)) }}
- name: PR_REVIEWER_ADMIN_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ ternary (printf "%s-admin" $fullname) $v.admin.existingSecret.name (empty $v.admin.existingSecret.name) }}
      key: {{ default "token" $v.admin.existingSecret.key }}
{{- end }}
- name: PR_REVIEWER_ADMIN_AUTH_MODE
  value: {{ $v.admin.auth.mode | quote }}
{{- if eq $v.admin.auth.mode "oidc" }}
- name: PR_REVIEWER_ADMIN_OIDC_ISSUER
  value: {{ $v.admin.auth.oidc.issuer | quote }}
- name: PR_REVIEWER_ADMIN_OIDC_CLIENT_ID
  value: {{ $v.admin.auth.oidc.clientId | quote }}
- name: PR_REVIEWER_ADMIN_OIDC_REDIRECT_BASE
  value: {{ $v.admin.auth.oidc.redirectBase | quote }}
- name: PR_REVIEWER_ADMIN_OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ ternary (printf "%s-admin-oidc" $fullname) $v.admin.auth.oidc.existingSecret.name (empty $v.admin.auth.oidc.existingSecret.name) }}
      key: {{ default "client-secret" $v.admin.auth.oidc.existingSecret.key }}
{{- with $v.admin.auth.oidc.allowedSubjects }}
- name: PR_REVIEWER_ADMIN_OIDC_ALLOWED_SUBJECTS
  value: {{ join "," . | quote }}
{{- end }}
{{- with $v.admin.auth.oidc.allowedEmails }}
- name: PR_REVIEWER_ADMIN_OIDC_ALLOWED_EMAILS
  value: {{ join "," . | quote }}
{{- end }}
{{- with $v.admin.auth.oidc.allowedGroups }}
- name: PR_REVIEWER_ADMIN_OIDC_ALLOWED_GROUPS
  value: {{ join "," . | quote }}
{{- end }}
- name: PR_REVIEWER_ADMIN_OIDC_SESSION_TTL_MS
  value: {{ mul $v.admin.auth.oidc.sessionTtlMinutes 60000 | quote }}
{{- end }}
{{- /* the admin surface's network policy bounds ingress; wildcard binding
makes health, readiness, and metrics reachable by probes and Prometheus */}}
{{- if $v.admin.dashboard }}
{{/* #742 dashboard: rendered only when the knob is on, with the exact ON
spelling the lexical check in src/controller/main.ts accepts; OFF stays
genuinely absent — an empty value is never emitted (unset is OFF) */}}
- name: PR_REVIEWER_ADMIN_DASHBOARD
  value: "true"
{{- end }}
{{- end }}
{{- if and $v.reconcile.enabled (not (empty $v.reconcile.repos)) }}
- name: PR_REVIEWER_RECONCILE_INTERVAL_MS
  value: {{ $v.reconcile.intervalMs | quote }}
- name: PR_REVIEWER_RECONCILE_REPOS
  value: {{ join "," $v.reconcile.repos | quote }}
{{- end }}
{{- if and (eq $v.forgeAuth.platform "github") (not (empty $v.reconcile.githubInstallationId)) }}
{{- /* #1723: the installation identity is BOTH the poll's minted identity
and the webhook intake's repair for a delivery that omitted
`installation.id`, so it is emitted whenever configured — not only when the
poll is enabled. */}}
- name: PR_REVIEWER_GITHUB_APP_INSTALLATION_ID
  value: {{ $v.reconcile.githubInstallationId | quote }}
{{- end }}
{{- if eq $v.forgeAuth.platform "github" }}
- name: PR_REVIEWER_GITHUB_APP_ID
  value: {{ $v.forgeAuth.github.appId | quote }}
- name: PR_REVIEWER_GITHUB_APP_PRIVATE_KEY_FILE
  value: {{ printf "/secrets/github-app/%s" (default "private-key.pem" $v.forgeAuth.github.appPrivateKeyExistingSecret.key) | quote }}
{{- else }}
- name: FORGEJO_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $v.forgeAuth.forgejo.existingSecret.name }}
      key: {{ default "token" $v.forgeAuth.forgejo.existingSecret.key }}
{{- end }}
{{- range $ref, $cred := $v.credentials }}
{{- $secretRef := get $cred "existingSecret" | default dict }}
{{- $inlineKey := include "pr-reviewer.credential-env-name" $ref | trimPrefix "PR_REVIEWER_CREDENTIAL_" }}
- name: {{ include "pr-reviewer.credential-env-name" $ref }}
  valueFrom:
    secretKeyRef:
      name: {{ ternary (printf "%s-credentials" $fullname) $secretRef.name (empty $secretRef.name) }}
      key: {{ default $inlineKey $secretRef.key }}
{{- end }}
{{- with $v.followUp.model }}
- name: PR_REVIEWER_FOLLOWUP_MODEL
  value: {{ . | quote }}
{{- end }}
{{- with $v.followUp.mentions }}
- name: PR_REVIEWER_FOLLOWUP_MENTIONS
  value: {{ join "," . | quote }}
{{- end }}
{{- range $entry := $v.env }}
{{ toYaml (list $entry) }}
{{- end }}
{{- end -}}

{{/*
Controller container's probes. With the admin listener enabled it binds
the pod-wide wildcard (PR_REVIEWER_ADMIN_BIND=0.0.0.0), so kubelet HTTP
probes reach /healthz and /readyz on the admin port. Without it the
listener is loopback-only: readiness proves the webhook intake is bound
(TCP), and the exec fallback proves the node runtime is alive.
*/}}
{{- define "pr-reviewer.controller.probes" -}}
{{- $v := .Values -}}
liveness:
  enabled: true
{{- if $v.admin.enabled }}
  type: HTTP
  path: /healthz
  port: {{ $v.admin.port }}
{{- else }}
  type: COMMAND
  command: ["node", "-e", "process.exit(0)"]
{{- end }}
  spec:
    periodSeconds: 20
    failureThreshold: 6
readiness:
  enabled: true
{{- if $v.admin.enabled }}
  type: HTTP
  path: /readyz
  port: {{ $v.admin.port }}
{{- else if $v.webhook.enabled }}
  type: TCP
  port: {{ $v.webhook.port }}
{{- else }}
  type: COMMAND
  command: ["node", "-e", "process.exit(0)"]
{{- end }}
  spec:
    periodSeconds: 10
    failureThreshold: 6
{{- end -}}

{{- define "pr-reviewer.std.webhook" -}}
{{- $std := .Values.webhook | default dict -}}
{{- $advanced := .Values.controller.webhook | default dict -}}
{{- if and $std.enabled $advanced.enabled -}}{{ fail "webhook.enabled conflicts with controller.webhook.enabled" }}{{- end -}}
{{- /* #1768 review: standard mode owns webhook secret material AND the
       webhook Service. Any advanced residue for the same concern merges
       silently (bjw-s enables a Service whenever `enabled` is absent, and
       the env wiring prefers existingSecret over secret), so it must fail
       the render instead of shadowing the standard section. */ -}}
{{- if and $std.enabled $advanced.secret -}}{{ fail "webhook.secret conflicts with the standard webhook.secret/webhook.existingSecret" }}{{- end -}}
{{- if and $std.enabled (dig "existingSecret" "name" "" $advanced) -}}{{ fail "controller.webhook.existingSecret.name conflicts with the standard webhook.secret/webhook.existingSecret" }}{{- end -}}
{{- $svc := dig "service" "webhook" dict .Values.controller -}}
{{- if and $std.enabled (not (empty $svc)) -}}
{{- range $key, $_ := $svc -}}{{- if not (has $key (list "enabled" "controller" "type" "ports")) -}}{{ fail (printf "controller.service.webhook.%s conflicts with the standard webhook Service derivation" $key) }}{{- end -}}{{- end -}}
{{- if dig "enabled" false $svc -}}{{ fail "webhook.enabled conflicts with controller.service.webhook.enabled" }}{{- end -}}
{{- $svcType := dig "type" "ClusterIP" $svc -}}
{{- if ne $svcType "ClusterIP" -}}{{ fail (printf "controller.service.webhook.type %s conflicts with the standard webhook Service derivation" $svcType) }}{{- end -}}
{{- $svcPort := dig "ports" "webhook" "port" (dig "webhook" "port" 8080 $advanced) $svc -}}
{{- if ne ($svcPort | int) ((dig "port" 8080 $advanced) | int) -}}{{ fail "controller.service.webhook.ports.webhook.port conflicts with the webhook listener port derived from controller.webhook.port" }}{{- end -}}
{{- range $key, $_ := (dig "ports" dict $svc) -}}{{- if ne $key "webhook" -}}{{ fail (printf "controller.service.webhook.ports.%s conflicts with the standard webhook Service derivation" $key) }}{{- end -}}{{- end -}}
{{- end -}}
{{- if and $std.enabled $std.existingSecret $std.secret -}}{{ fail "webhook.existingSecret and webhook.secret are mutually exclusive" }}{{- end -}}
{{- if and $std.enabled (not .Values.controller.enabled) -}}{{ fail "webhook.enabled requires controller.enabled" }}{{- end -}}
{{- $intakePath := $std.path | default "/hook" -}}
{{- if and $std.enabled (or (empty $intakePath) (not (hasPrefix "/" $intakePath))) -}}{{ fail "webhook.path must be an absolute request path starting with / (forge deliveries POST there; Gitea/GitLab instances need their canonical /webhooks/<forge> route)" }}{{- end -}}
{{- $fullname := include "pr-reviewer.resource-fullname" (dict "releaseName" .Release.Name "chartName" .Chart.Name "nameOverride" .Values.controller.nameOverride "fullnameOverride" .Values.controller.fullnameOverride) -}}
{{- dict "enabled" ($std.enabled | default false) "port" ($advanced.port | default 8080) "path" $intakePath "secretRefName" ($std.existingSecret | default "") "secretRefKey" "webhook-secret" "inlineSecret" ($std.secret | default "") "serviceName" (printf "%s-webhook" $fullname | lower) | toYaml -}}
{{- end -}}

{{- define "pr-reviewer.std.admin" -}}
{{- $std := .Values.dashboard | default dict -}}
{{- $advanced := .Values.controller.admin | default dict -}}
{{- if and $std.enabled (or $advanced.enabled $advanced.dashboard) -}}{{ fail "dashboard.enabled conflicts with controller.admin.enabled or controller.admin.dashboard" }}{{- end -}}
{{- if and $std.enabled (eq (dig "auth" "mode" "token" $advanced) "oidc") -}}{{ fail "dashboard.enabled conflicts with controller.admin.auth.mode oidc" }}{{- end -}}
{{- /* #1768 review: the standard section owns the admin token material —
       advanced residue would silently shadow it (env prefers
       existingSecret), so it fails the render. */ -}}
{{- if and $std.enabled $advanced.token -}}{{ fail "controller.admin.token conflicts with the standard dashboard.secret/dashboard.existingSecret" }}{{- end -}}
{{- if and $std.enabled (dig "existingSecret" "name" "" $advanced) -}}{{ fail "controller.admin.existingSecret.name conflicts with the standard dashboard.secret/dashboard.existingSecret" }}{{- end -}}
{{- /* #1768 review: the standard section owns the admin Service; the
       chart ships no default `controller.service.admin`, so ANY content
       there is operator-authored residue that would otherwise merge
       silently (a LoadBalancer admin Service would publish the
       unauthenticated /metrics surface directly). */ -}}
{{- if and $std.enabled (not (empty (dig "service" "admin" dict .Values.controller))) -}}{{ fail "controller.service.admin conflicts with the standard dashboard Service derivation" }}{{- end -}}
{{- if and $std.enabled $std.existingSecret $std.secret -}}{{ fail "dashboard.existingSecret and dashboard.secret are mutually exclusive" }}{{- end -}}
{{- if and $std.enabled (not .Values.controller.enabled) -}}{{ fail "dashboard.enabled requires controller.enabled" }}{{- end -}}
{{- $fullname := include "pr-reviewer.resource-fullname" (dict "releaseName" .Release.Name "chartName" .Chart.Name "nameOverride" .Values.controller.nameOverride "fullnameOverride" .Values.controller.fullnameOverride) -}}
{{- dict "enabled" ($std.enabled | default false) "dashboard" ($std.enabled | default false) "port" ($advanced.port | default 8081) "tokenRefName" ($std.existingSecret | default "") "tokenRefKey" "token" "inlineToken" ($std.secret | default "") "serviceName" (printf "%s-admin" $fullname | lower) "authMode" "token" | toYaml -}}
{{- end -}}

{{- define "pr-reviewer.std.route" -}}
{{- $webhook := include "pr-reviewer.std.webhook" . | fromYaml -}}
{{- $admin := include "pr-reviewer.std.admin" . | fromYaml -}}
{{- dict "webhook" $webhook "admin" $admin | toYaml -}}
{{- end -}}

{{/*
Validate the controller wiring fail-closed at render time and inject the
template-conditional pieces (env, probes, rendered Secrets, persistence)
into the component values before the common library renders. Signature:
dict "ctx" <component context> "root" <chart root>
"workerExecutorKubernetes" <bool>.
*/}}
{{- define "pr-reviewer.controller.configure" -}}
{{- $ctx := index . "ctx" -}}
{{- $root := index . "root" -}}
{{- $kubeExecutor := index . "workerExecutorKubernetes" -}}
{{- $v := $ctx.Values -}}
{{- $fullname := include "pr-reviewer.fullname" $ctx -}}
{{- $stdWebhook := include "pr-reviewer.std.webhook" $root | fromYaml -}}
{{- $stdAdmin := include "pr-reviewer.std.admin" $root | fromYaml -}}
{{- if $stdWebhook.enabled -}}
{{- $_ := set $v.webhook "enabled" true -}}
{{- /* #1768 review: the standard section owns the secret selection —
       BOTH fields are set (one empty) so no advanced residue can
       shadow it through the env wiring's existingSecret preference. */ -}}
{{- if $stdWebhook.secretRefName -}}
{{- $_ := set $v.webhook "existingSecret" (dict "name" $stdWebhook.secretRefName "key" $stdWebhook.secretRefKey) -}}
{{- $_ := set $v.webhook "secret" "" -}}
{{- else -}}
{{- $_ := set $v.webhook "existingSecret" (dict "name" "" "key" $stdWebhook.secretRefKey) -}}
{{- $_ := set $v.webhook "secret" $stdWebhook.inlineSecret -}}
{{- end -}}
{{- $_ := set $v "service" (mustMergeOverwrite ($v.service | default dict) (dict "webhook" (dict "enabled" true "forceRename" $stdWebhook.serviceName "controller" "main" "ports" (dict "webhook" (dict "port" $stdWebhook.port))))) -}}
{{- end -}}
{{- if $stdAdmin.enabled -}}
{{- $_ := set $v.admin "enabled" true -}}{{- $_ := set $v.admin "dashboard" true -}}{{- $_ := set $v.admin.auth "mode" "token" -}}
{{- /* #1768 review: same authority rule for the admin token material. */ -}}
{{- if $stdAdmin.tokenRefName -}}
{{- $_ := set $v.admin "existingSecret" (dict "name" $stdAdmin.tokenRefName "key" $stdAdmin.tokenRefKey) -}}
{{- $_ := set $v.admin "token" "" -}}
{{- else -}}
{{- $_ := set $v.admin "existingSecret" (dict "name" "" "key" $stdAdmin.tokenRefKey) -}}
{{- $_ := set $v.admin "token" $stdAdmin.inlineToken -}}
{{- end -}}
{{- $_ := set $v "service" (mustMergeOverwrite ($v.service | default dict) (dict "admin" (dict "enabled" true "forceRename" $stdAdmin.serviceName "controller" "main" "ports" (dict "admin" (dict "port" $stdAdmin.port))))) -}}
{{- end -}}

{{- /* fail closed on incomplete wiring — the daemon would refuse anyway */ -}}
{{- if empty (dig "controllers" "main" "containers" "main" "image" "repository" "" $v) -}}
{{- fail "controller.controllers.main.containers.main.image.repository is required" -}}
{{- end -}}
{{- if and (empty $v.controlPlaneUrl) (empty $v.controlPlaneUrlExistingSecret.name) -}}
{{- fail "controller.controlPlaneUrl or controller.controlPlaneUrlExistingSecret.name is required" -}}
{{- end -}}
{{- if and (empty $v.instanceConfig) (empty $v.instanceConfigExistingSecret.name) -}}
{{- fail "controller.instanceConfig or controller.instanceConfigExistingSecret.name is required" -}}
{{- end -}}
{{- if $v.webhook.enabled -}}
{{- if and (empty $v.webhook.secret) (empty $v.webhook.existingSecret.name) -}}
{{- fail "controller.webhook.secret or controller.webhook.existingSecret.name is required when the webhook intake is enabled" -}}
{{- end -}}
{{- end -}}
{{- if $v.admin.enabled -}}
{{- $authMode := $v.admin.auth.mode | default "token" -}}
{{- if not (has $authMode (list "token" "oidc")) -}}
{{- fail "controller.admin.auth.mode must be token or oidc" -}}
{{- end -}}
{{- if eq $authMode "token" -}}
{{- if and (empty $v.admin.token) (empty $v.admin.existingSecret.name) -}}
{{- fail "controller.admin.token or controller.admin.existingSecret.name is required in token mode" -}}
{{- end -}}
{{- else -}}
{{- $oidc := $v.admin.auth.oidc -}}
{{- if or (empty $oidc.issuer) (empty $oidc.clientId) (empty $oidc.redirectBase) -}}
{{- fail "controller.admin.auth.oidc issuer, clientId, and redirectBase are required in OIDC mode" -}}
{{- end -}}
{{- if and (empty $oidc.clientSecret) (empty $oidc.existingSecret.name) -}}
{{- fail "controller.admin.auth.oidc clientSecret or existingSecret.name is required in OIDC mode" -}}
{{- end -}}
{{- if and (not (empty $oidc.clientSecret)) (not (empty $oidc.existingSecret.name)) -}}
{{- fail "controller.admin.auth.oidc clientSecret and existingSecret.name are mutually exclusive (one inline value, one reference)" -}}
{{- end -}}
{{- if not $v.admin.dashboard -}}
{{- fail "controller.admin.auth.mode oidc requires controller.admin.dashboard (the OIDC sign-in flow ends on the dashboard shell)" -}}
{{- end -}}
{{- if and (empty $oidc.allowedSubjects) (empty $oidc.allowedEmails) (empty $oidc.allowedGroups) -}}
{{- fail "controller.admin.auth.oidc requires at least one allowlist" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and $v.admin.dashboard (not $v.admin.enabled) -}}
{{- fail "controller.admin.dashboard requires controller.admin.enabled (the dashboard is served on the admin listener)" -}}
{{- end -}}
{{- if and $v.reconcile.enabled (not (empty $v.reconcile.repos)) -}}
{{- if and (eq $v.forgeAuth.platform "github") (empty $v.reconcile.githubInstallationId) -}}
{{- fail "controller.reconcile.githubInstallationId is required when reconciliation is enabled and forgeAuth.platform is github" -}}
{{- end -}}

{{- end -}}
{{- if eq $v.forgeAuth.platform "github" -}}
{{- if empty $v.forgeAuth.github.appId -}}
{{- fail "controller.forgeAuth.github.appId is required when forgeAuth.platform is github" -}}
{{- end -}}
{{- if and (empty $v.forgeAuth.github.appPrivateKey) (empty $v.forgeAuth.github.appPrivateKeyExistingSecret.name) -}}
{{- fail "controller.forgeAuth.github private key material (appPrivateKey or appPrivateKeyExistingSecret.name) is required" -}}
{{- end -}}
{{- else -}}
{{- if and (empty $v.forgeAuth.forgejo.token) (empty $v.forgeAuth.forgejo.existingSecret.name) -}}
{{- fail "controller.forgeAuth.forgejo token material (token or existingSecret.name) is required" -}}
{{- end -}}
{{- end -}}

{{- /* secrets the chart renders itself (forceRenamed so the env wiring
       and the rendered objects can never drift apart) */ -}}
{{- $rendered := dict -}}
{{- if not (empty $v.controlPlaneUrl) -}}
{{- $_ := set $rendered "control-plane" (dict "forceRename" (printf "%s-control-plane" $fullname) "stringData" (dict "dsn" $v.controlPlaneUrl)) -}}
{{- end -}}
{{- if and $v.webhook.enabled (empty $v.webhook.existingSecret.name) -}}
{{- $_ := set $rendered "webhook" (dict "forceRename" (printf "%s-webhook" $fullname) "stringData" (dict "webhook-secret" $v.webhook.secret)) -}}
{{- end -}}
{{- if and $v.admin.enabled (not (empty $v.admin.token)) (empty $v.admin.existingSecret.name) -}}
{{- $_ := set $rendered "admin" (dict "forceRename" (printf "%s-admin" $fullname) "stringData" (dict "token" $v.admin.token)) -}}
{{- end -}}
{{- if and $v.admin.enabled (eq $v.admin.auth.mode "oidc") (not (empty $v.admin.auth.oidc.clientSecret)) (empty $v.admin.auth.oidc.existingSecret.name) -}}
{{- $_ := set $rendered "admin-oidc" (dict "forceRename" (printf "%s-admin-oidc" $fullname) "stringData" (dict "client-secret" $v.admin.auth.oidc.clientSecret)) -}}
{{- end -}}
{{- $inlineCredentials := dict -}}
{{- range $ref, $cred := $v.credentials -}}
{{- if not (empty (get $cred "value")) -}}
{{- $_ := set $inlineCredentials (include "pr-reviewer.credential-env-name" $ref | trimPrefix "PR_REVIEWER_CREDENTIAL_") (get $cred "value") -}}
{{- end -}}
{{- end -}}
{{- if not (empty $inlineCredentials) -}}
{{- $_ := set $rendered "credentials" (dict "forceRename" (printf "%s-credentials" $fullname) "stringData" $inlineCredentials) -}}
{{- end -}}
{{- if not (empty $v.instanceConfig) -}}
{{- $_ := set $rendered "instance-config" (dict "forceRename" (printf "%s-instance-config" $fullname) "stringData" (dict "instance-config.yaml" $v.instanceConfig)) -}}
{{- end -}}
{{- if and (eq $v.forgeAuth.platform "github") (not (empty $v.forgeAuth.github.appPrivateKey)) -}}
{{- $_ := set $rendered "github-app" (dict "forceRename" (printf "%s-github-app" $fullname) "stringData" (dict "private-key.pem" $v.forgeAuth.github.appPrivateKey)) -}}
{{- end -}}
{{- $_ := set $v "secrets" (mustMergeOverwrite ($v.secrets | default dict) $rendered) -}}

{{- /* persistence: the instance-config mount (chart-rendered secret or
       operator-provided existing secret), read-only */ -}}
{{- $instanceSecretName := "" -}}
{{- if not (empty $v.instanceConfig) -}}
{{- $instanceSecretName = printf "%s-instance-config" $fullname -}}
{{- else -}}
{{- $instanceSecretName = $v.instanceConfigExistingSecret.name -}}
{{- end -}}
{{- $_ := set $v "persistence" (mustMergeOverwrite ($v.persistence | default dict) (dict "instance-config" (dict "type" "secret" "name" $instanceSecretName "globalMounts" (list (dict "path" "/config" "readOnly" true))))) -}}

{{- /* GitHub App private key: mounted read-only — from the operator's
       existing secret, or from the chart-rendered one above; the env var
       names the file the mount produces */ -}}
{{- if eq $v.forgeAuth.platform "github" -}}
{{- $githubKeySecret := $v.forgeAuth.github.appPrivateKeyExistingSecret.name -}}
{{- if empty $githubKeySecret -}}
{{- $githubKeySecret = printf "%s-github-app" $fullname -}}
{{- end -}}
{{- $_ := set $v "persistence" (mustMergeOverwrite $v.persistence (dict "github-app" (dict "type" "secret" "name" $githubKeySecret "globalMounts" (list (dict "path" "/secrets/github-app" "readOnly" true))))) -}}
{{- end -}}

{{- /* env + probes: template-conditional, injected into the container */ -}}
{{- $controllers := deepCopy ($v.controllers | default dict) -}}
{{- $main := index $controllers "main" -}}
{{- $container := index (index $main "containers") "main" -}}
{{- $_ := set $container "env" (include "pr-reviewer.controller.env" (dict "ctx" $ctx "root" $root "workerExecutorKubernetes" $kubeExecutor) | fromYamlArray) -}}
{{- $_ := set $container "probes" (include "pr-reviewer.controller.probes" $ctx | fromYaml) -}}
{{- if $kubeExecutor -}}
{{- /* the Kubernetes executor needs the controller's in-cluster identity
       to create/delete worker Jobs; otherwise no token is mounted */ -}}
{{- $_ := set $main "pod" (mustMergeOverwrite ($main.pod | default dict) (dict "automountServiceAccountToken" true)) -}}
{{- $sa := index ($v.serviceAccount | default dict) "main" -}}
{{- if not (empty $sa) -}}
{{- $_ := set $sa "automountServiceAccountToken" true -}}
{{- end -}}
{{- end -}}
{{- /* #1725/#1737: the kubelet applies fsGroup to freshly provisioned claim
       roots as group-WRITABLE (mode 0775), and a fresh claim root is
       otherwise owned by uid 0 (mode 0755), while the runtime's own trust
       check (assertTrustedDirChain in src/acquisition/mirror.ts) refuses any
       cache root that is group/other-writable or not owned by the process
       uid — the controller would fail "cache root is writable by group or
       other" (or "not owned by the controller uid") before the first job in
       EVERY executor mode, not only the Kubernetes executor #1725/#1736
       fixed. A chart-owned root init container therefore chowns/chmods the
       claim roots before the controller starts in BOTH modes, because
       neither executor can repair a root it does not own. The shape differs
       per mode, decided by who writes below the root:
       — kubernetes-executor: mode 2750, group = the shared worker group
         (fsGroup), setgid set. Owner-write only, the shared group keeps
         read/execute, and the setgid bit must persist:
         shareRunDirectoryGroup chmods the components below the root but
         never chgroups them, so without root setgid each <jobId> dir would
         inherit the controller's primary group (1000) instead of 65532 and
         the worker would be refused traversal one level below the root.
       — controller-only: mode 0750, same owner/group, NO setgid. The local
         executor spawns the worker as the controller's own uid and never
         chowns/chgrps anything below these roots, so no cross-uid writer
         consumes group inheritance: the owner bits are the entire write
         surface, and group read/execute is just the declared fsGroup
         posture. Copying the Kubernetes-mode setgid here by analogy would
         add a bit no trace needs.
       Durability is NOT fsGroupChangePolicy OnRootMismatch (#1736): that
       policy skips only when the root GID matches AND the root mode is a
       superset of 0770 WITH setgid set (requiresPermissionChange,
       kubernetes pkg/volume/volume_linux.go — its own example treats 0750
       as a mismatch), and a trusted root may never be group-writable, so a
       fixed root always re-triggers. With fsGroup absent, kubelet performs
       no restyle at all and the init container still fixes the fresh root's
       uid 0 ownership. The fix survives because no workload mounts these
       claims with fsGroup except the controller pod itself: the executor's
       worker Job manifest carries no fsGroup (#1736, pinned by the worker
       admission policy), and the controller pod's own fsGroup processing
       runs at pod startup BEFORE this init container, which repairs the
       root again before the controller process starts. Other workloads
       must never mount these claims with fsGroup — any fsGroup mount
       recursively restyles the whole claim (chgrp to its fsGroup plus
       group-writable bits) the moment it starts. chown needs CAP_CHOWN and
       the post-handoff chmod needs CAP_FOWNER; everything else stays
       dropped. The mounts themselves ride the persistence globalMounts,
       which the common library renders for every container type
       (container.spec calls the volumeMounts field for init containers
       too) — the charts CI pins that both example renders carry both
       claim-root mounts on fix-roots; operators who relocate
       controller.paths.* must keep the persistence globalMounts in sync (an
       unmounted root fails loudly: the read-only rootfs makes the init
       container error). */ -}}
{{- $podSecurity := dig "defaultPodOptions" "securityContext" dict $v -}}
{{- $rootUid := int64 ($podSecurity.runAsUser | default 1000) -}}
{{- $rootGid := int64 ($podSecurity.fsGroup | default 65532) -}}
{{- $claimRootMode := "0750" -}}
{{- if $kubeExecutor -}}
{{- $claimRootMode = "2750" -}}
{{- end -}}
{{- $quotedRoots := list -}}
{{- range $claimRoot := (list $v.paths.runsRoot $v.paths.workspaceCacheRoot) -}}
{{- $quotedRoots = append $quotedRoots (quote $claimRoot) -}}
{{- end -}}
{{- $rootArgs := join " " $quotedRoots -}}
{{- $fixRoots := dict
  "image" $container.image
  "command" (list "/bin/sh" "-c")
  "args" (list (printf "chown %d:%d %s && chmod %s %s" $rootUid $rootGid $rootArgs $claimRootMode $rootArgs))
  "securityContext" (dict
    "runAsNonRoot" false
    "runAsUser" 0
    "runAsGroup" 0
    "allowPrivilegeEscalation" false
    "readOnlyRootFilesystem" true
    "capabilities" (dict "drop" (list "ALL") "add" (list "CHOWN" "FOWNER"))
    "seccompProfile" (dict "type" "RuntimeDefault"))
}}
{{- /* The common library models controllers.<name>.initContainers as a map
       keyed by container name (bjw-s common 5.x pod.field.initContainers
       ranges key/values), which is also the shape this merge preserves.
       A raw Kubernetes container list is invalid for the library itself;
       fail with the actionable shape instead of an opaque sprig merge
       type error. */ -}}
{{- $operatorInitContainers := $main.initContainers | default dict -}}
{{- if not (kindIs "map" $operatorInitContainers) -}}
{{- fail "controller.controllers.main.initContainers must be a map keyed by container name (the common-library shape); a raw Kubernetes container list is not supported" -}}
{{- end -}}
{{- $_ := set $main "initContainers" (mustMergeOverwrite $operatorInitContainers (dict "fix-roots" $fixRoots)) -}}
{{- $_ := set $v "controllers" $controllers -}}
{{- end -}}
