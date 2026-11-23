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

{{/*
The controller container's environment: the complete mapping of chart
values onto the fail-closed env contract in src/controller/main.ts.
Conditional variables are genuinely ABSENT when their feature is off —
an empty `PR_REVIEWER_ADMIN_PORT` would be a startup refusal, not a
skip. Secret material always travels through secretKeyRef, never inline.
*/}}
{{- define "pr-reviewer.controller.env" -}}
{{- $v := .Values -}}
{{- $fullname := include "pr-reviewer.fullname" . -}}
- name: PR_REVIEWER_INSTANCE_CONFIG
  value: /config/instance-config.yaml
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

{{/*
The standard shared worker/controller storage (#1767), derived from the
single source `controller.persistence`: one entry per standard key, in a
fixed order, each naming the resolved claim and the controller-side root
the runtime contract mounts it at. The claim resolves to the operator's
`existingClaim`, or to the chart-created `<fullname>-<key>` PVC the
configure step pins with forceRename. #1766 consumes this artifact to
synthesize the default Kubernetes executor profile's volume mappings.
Every ambiguous or missing shape fails closed here, in one place.
*/}}
{{- define "pr-reviewer.shared-volume-mappings" -}}
{{- $v := index . "values" -}}
{{- $fullname := index . "fullname" -}}
{{- $mappings := list -}}
{{- range $item := (list (dict "key" "runs" "pathField" "runsRoot") (dict "key" "workspace-cache" "pathField" "workspaceCacheRoot")) -}}
{{- $key := $item.key -}}
{{- $root := index $v.paths $item.pathField -}}
{{- $persistence := $v.persistence | default dict -}}
{{- if not (hasKey $persistence $key) -}}
{{- fail (printf "controller.persistence.%s is required as the standard shared storage (or set an explicit advanced topology)" $key) -}}
{{- end -}}
{{- $entry := index $persistence $key -}}
{{- if or (not (kindIs "map" $entry)) (and (hasKey $entry "enabled") (not $entry.enabled)) -}}
{{- fail (printf "controller.persistence.%s is required as the standard shared storage (or set an explicit advanced topology)" $key) -}}
{{- end -}}
{{- $claim := $entry.existingClaim -}}
{{- if empty $claim -}}
{{- $type := $entry.type | default "persistentVolumeClaim" -}}
{{- if ne $type "persistentVolumeClaim" -}}
{{- fail (printf "controller.persistence.%s must be an operator-provided existingClaim or a chart-created persistentVolumeClaim (standard shared storage)" $key) -}}
{{- end -}}
{{- /* The common library lowercases rendered object names; derive the
       same spelling so the artifact, the forceRename pin, and the
       redeclare guard can never drift from the rendered PVC. */ -}}
{{- $claim = printf "%s-%s" $fullname $key | lower -}}
{{- end -}}
{{- $mappings = append $mappings (dict "key" $key "claim" $claim "controllerRoot" $root) -}}
{{- end -}}
{{- $mappings | toYaml -}}
{{- end -}}

{{/*
Validate the controller wiring fail-closed at render time and inject the
template-conditional pieces (env, probes, rendered Secrets, persistence)
into the component values before the common library renders. Signature:
dict "ctx" <component context> "workerExecutorKubernetes" <bool> "workerExecutor" <map>.
*/}}
{{- define "pr-reviewer.controller.configure" -}}
{{- $ctx := index . "ctx" -}}
{{- $kubeExecutor := index . "workerExecutorKubernetes" -}}
{{- $workerExecutor := index . "workerExecutor" -}}
{{- $v := $ctx.Values -}}
{{- $fullname := include "pr-reviewer.fullname" $ctx -}}

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

{{- /* #1767: the standard shared storage is declared once under
       controller.persistence and derived here. The mappings define is the
       single validation source for the two shared keys: it resolves each
       standard claim and fails closed on every missing, disabled, or
       ambiguous shape. */ -}}
{{- $paths := $v.paths | default dict -}}
{{- range $field := (list "runsRoot" "workspaceCacheRoot" "durableStateDir") -}}
{{- if or (empty (index $paths $field)) (not (hasPrefix "/" (index $paths $field))) -}}
{{- fail (printf "controller.paths.%s must be a non-empty absolute path starting with / (it is the single source for the standard mounts, the env contract, and fix-roots)" $field) -}}
{{- end -}}
{{- end -}}
{{- $mappings := include "pr-reviewer.shared-volume-mappings" (dict "values" $v "fullname" $fullname) | fromYamlArray -}}
{{- /* The standard mount path derives from controller.paths.* (the same
       source as the env contract and fix-roots), so a relocation stays
       one-source. Extra mounts of the same claim are allowed, but the
       root mount must exist and be writable: fix-roots reaches it through
       the globalMounts the common library renders for init containers,
       and a readOnly or relocated root breaks that contract silently.
       durable-state joins the two shared keys here: its claim is
       controller-internal, but the same mount contract applies. */ -}}
{{- $standardMounts := concat $mappings (list (dict "key" "durable-state" "controllerRoot" $paths.durableStateDir)) -}}
{{- range $mapping := $standardMounts -}}
{{- $persistenceValues := $v.persistence | default dict -}}
{{- if not (hasKey $persistenceValues $mapping.key) -}}
{{- fail (printf "controller.persistence.%s is required (the standard storage is single-source; relocate via controller.paths instead of removing or disabling the entry)" $mapping.key) -}}
{{- end -}}
{{- $entry := index $persistenceValues $mapping.key -}}
{{- if or (not (kindIs "map" $entry)) (and (hasKey $entry "enabled") (not $entry.enabled)) -}}
{{- fail (printf "controller.persistence.%s is required (the standard storage is single-source; relocate via controller.paths instead of removing or disabling the entry)" $mapping.key) -}}
{{- end -}}
{{- if hasKey $entry "globalMounts" -}}
{{- $writableRoot := false -}}
{{- range $mount := $entry.globalMounts -}}
{{- if eq $mount.path $mapping.controllerRoot -}}
{{- if $mount.readOnly -}}
{{- fail (printf "controller.persistence.%s is mounted readOnly at the controller.paths root %q; the runtime must write it" $mapping.key $mapping.controllerRoot) -}}
{{- end -}}
{{- $writableRoot = true -}}
{{- end -}}
{{- end -}}
{{- if not $writableRoot -}}
{{- fail (printf "controller.persistence.%s globalMounts must include the writable controller.paths root %q (extra mounts are allowed; relocate via controller.paths, single source)" $mapping.key $mapping.controllerRoot) -}}
{{- end -}}
{{- else -}}
{{- $_ := set $entry "globalMounts" (list (dict "path" $mapping.controllerRoot)) -}}
{{- end -}}
{{- end -}}
{{- if $kubeExecutor -}}
{{- range $mapping := $mappings -}}
{{- $entry := index $v.persistence $mapping.key -}}
{{- if empty $entry.existingClaim -}}
{{- /* Pin the chart-created claim name: the common library otherwise names
       PVCs by enabled-claim count (<fullname> for one, <fullname>-<key>
       for more), which no derived reference may depend on. The chart
       renders this claim itself, so a same-named workerExecutor.volumeClaims
       entry would render a second PVC. When the operator provides the
       claim via existingClaim, a matching volumeClaim is its provisioner
       (the pre-#1767 documented posture) and stays allowed. */ -}}
{{- $_ := set $entry "forceRename" $mapping.claim -}}
{{- range $claim := ($workerExecutor.volumeClaims | default list) -}}
{{- if eq ($claim.name | lower) $mapping.claim -}}
{{- fail (printf "workerExecutor.volumeClaims must not redeclare the chart-created standard claim %q (derived from controller.persistence.%s, #1767); volumeClaims is for additional non-standard claims, or for provisioning a claim named by controller.persistence.*.existingClaim" $mapping.claim $mapping.key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- /* Durable state must survive chart upgrades and uninstalls, and its
       name must be deterministic in EVERY mode: the common library's
       count-based naming would otherwise rename the claim when the shared
       posture changes. Kubernetes-executor mode pins the bare fullname
       (the name the documented pre-#1767 example posture rendered, so
       adopting the single-source shape does not orphan it); controller-only
       mode pins <fullname>-durable-state (the name its defaults render).
       An operator-set existingClaim or forceRename wins. retain keeps the
       PVC on uninstall and across the one-time rename of installs that
       ran Kubernetes-executor mode with chart-created shared claims. */ -}}
{{- $durableState := index ($v.persistence | default dict) "durable-state" | default dict -}}
{{- if empty $durableState.existingClaim -}}
{{- if not (hasKey $durableState "forceRename") -}}
{{- $durableStateName := ternary $fullname (printf "%s-durable-state" $fullname) $kubeExecutor -}}
{{- $_ := set $durableState "forceRename" ($durableStateName | lower) -}}
{{- end -}}
{{- if not (hasKey $durableState "retain") -}}
{{- $_ := set $durableState "retain" true -}}
{{- end -}}
{{- if $kubeExecutor -}}
{{- range $claim := ($workerExecutor.volumeClaims | default list) -}}
{{- if eq ($claim.name | lower) ($durableState.forceRename | lower) -}}
{{- fail (printf "workerExecutor.volumeClaims must not redeclare the chart-created durable-state claim %q (pinned by the chart, #1767)" $durableState.forceRename) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if $kubeExecutor -}}
{{- /* Worker Jobs run in the namespace their instance config names, and
       the standard claims are derived in the release namespace: PVCs are
       namespace-scoped, so every namespace in the topology must be the
       release namespace. workerExecutor.namespace is the provisioning
       mirror; when the instance config is inline the chart also checks
       its authoritative executor namespace (an opaque existingSecret
       cannot be checked and stays the operator's documented
       responsibility). */ -}}
{{- if ne (default $ctx.Release.Namespace $workerExecutor.namespace) $ctx.Release.Namespace -}}
{{- fail (printf "shared claims are namespace-scoped and the chart derives them once, in the release namespace %q; standard topology requires workerExecutor.namespace %q to equal the release namespace" $ctx.Release.Namespace $workerExecutor.namespace) -}}
{{- end -}}
{{- if not (empty $v.instanceConfig) -}}
{{- /* fromYaml yields an empty map on unparseable input: the check then
       finds no profiles and skips, which is acceptable because the runtime
       refuses an unparseable instance config at startup anyway. */ -}}
{{- $instanceCfg := fromYaml $v.instanceConfig -}}
{{- if kindIs "map" $instanceCfg -}}
{{- /* The derived artifact is the authority for the standard claims: the
       executor mounts each mapping's claim at its controller-root in BOTH
       pods, so an inline profile that repeats a derived claim at any other
       root diverges from the single source and silently breaks the
       shared-storage contract (a relocated controller.paths root moves
       the chart side only). The chart never rewrites operator config, so
       that drift refuses the render. The claim NAME is operator-owned and
       stays unverified: a stale name after a release-name change or an
       existingClaim rename is indistinguishable from a mapping on a
       non-standard claim (volumeClaims-provisioned or operator-managed),
       which stays supported; #1766 removes the repetition entirely by
       synthesizing the default profile from this artifact. */ -}}
{{- $rootByClaim := dict -}}
{{- range $mapping := $mappings -}}
{{- $_ := set $rootByClaim ($mapping.claim | lower) $mapping.controllerRoot -}}
{{- end -}}
{{- range $profile := (index $instanceCfg "executor-profiles" | default list) -}}
{{- if kindIs "map" $profile -}}
{{- $kubeProfile := index $profile "kubernetes" | default dict -}}
{{- if and (kindIs "map" $kubeProfile) (not (empty $kubeProfile.namespace)) (ne $kubeProfile.namespace $ctx.Release.Namespace) -}}
{{- fail (printf "instance config executor-profiles.kubernetes.namespace %q must equal the release namespace %q: the standard shared claims are derived in the release namespace and PVCs are namespace-scoped (#1767)" $kubeProfile.namespace $ctx.Release.Namespace) -}}
{{- end -}}
{{- if kindIs "map" $kubeProfile -}}
{{- range $volume := (index $kubeProfile "volumes" | default list) -}}
{{- if and (kindIs "map" $volume) (not (empty $volume.claim)) -}}
{{- $derivedRoot := index $rootByClaim ($volume.claim | lower) -}}
{{- $declaredRoot := index $volume "controller-root" | default "" -}}
{{- if and (not (empty $derivedRoot)) (ne $declaredRoot $derivedRoot) -}}
{{- fail (printf "instance config executor-profiles.kubernetes volumes claim %q must mount at the derived controller root %q (single source: controller.persistence claim and controller.paths root, #1767); a raw instance config repeats the derived mappings by hand until #1766 synthesizes the default profile, and a divergent root refuses the render" $volume.claim $derivedRoot) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- /* env + probes: template-conditional, injected into the container */ -}}
{{- $controllers := deepCopy ($v.controllers | default dict) -}}
{{- $main := index $controllers "main" -}}
{{- $container := index (index $main "containers") "main" -}}
{{- $_ := set $container "env" (include "pr-reviewer.controller.env" $ctx | fromYamlArray) -}}
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
