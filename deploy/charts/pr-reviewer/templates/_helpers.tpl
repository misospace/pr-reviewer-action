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
"workerExecutorKubernetes" <bool> "sharedVolumesJson" <string>.
Conditional variables are genuinely ABSENT when their feature is off.
Secret material uses secretKeyRef. */}}
{{- define "pr-reviewer.controller.env" -}}
{{- $ctx := index . "ctx" -}}
{{- $root := index . "root" -}}
{{- $kubeExecutor := index . "workerExecutorKubernetes" -}}
{{- $sharedVolumesJson := index . "sharedVolumesJson" | default "" -}}
{{- $v := $ctx.Values -}}
{{- $fullname := include "pr-reviewer.fullname" $ctx | lower -}}
- name: PR_REVIEWER_INSTANCE_CONFIG
  value: /config/instance-config.yaml
{{- if $kubeExecutor }}
- name: PR_REVIEWER_KUBERNETES_DEPLOYMENT_DEFAULTS
  value: {{ include "pr-reviewer.worker-deployment-defaults" $root | quote }}
{{- if ne $sharedVolumesJson "" }}
- name: PR_REVIEWER_KUBERNETES_SHARED_VOLUMES
  value: {{ $sharedVolumesJson | quote }}
{{- end }}
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
{{- /* #1768 review round 2: the standard merge is authoritative for
       enabled/type/forceRename/ports.webhook.port (it overwrites them),
       so the guard only refuses what the merge CANNOT remove: extra
       keys, extra ports, and explicit advanced enablement. */ -}}
{{- if and $std.enabled (not (empty $svc)) -}}
{{- range $key, $_ := $svc -}}{{- if not (has $key (list "enabled" "controller" "type" "ports")) -}}{{ fail (printf "controller.service.webhook.%s conflicts with the standard webhook Service derivation" $key) }}{{- end -}}{{- end -}}
{{- if dig "enabled" false $svc -}}{{ fail "webhook.enabled conflicts with controller.service.webhook.enabled" }}{{- end -}}
{{- range $key, $_ := (dig "ports" dict $svc) -}}{{- if ne $key "webhook" -}}{{ fail (printf "controller.service.webhook.ports.%s conflicts with the standard webhook Service derivation" $key) }}{{- end -}}{{- end -}}
{{- end -}}
{{- if and $std.enabled $std.existingSecret $std.secret -}}{{ fail "webhook.existingSecret and webhook.secret are mutually exclusive" }}{{- end -}}
{{- if and $std.enabled (not .Values.controller.enabled) -}}{{ fail "webhook.enabled requires controller.enabled" }}{{- end -}}
{{- $intakePath := $std.path | default "/hook" -}}
{{- /* The intake path must stay a usable HTTPRoute rule value and must
        never collide with the reserved admin surface (a first-rule
        PathPrefix "/" or "/admin" would swallow the dashboard and the
        bearer-guarded API with no render-time error). The collision
        check is semantic, not string-exact: Gateway API PathPrefix
        matching is element-based and ignores a trailing "/", so
        /admin/ resolves to the same rule as /admin, //admin to the
        same rule on slash-normalizing infrastructure, and any deeper
        path under a reserved prefix (/admin/api) matches that rule
        too — the intake rule is emitted FIRST and would capture the
        traffic. Trailing slashes carry no match semantics, so they
        normalize away before comparing; duplicate slashes and dot
        segments would render an intake rule that never matches its
        intent (silently dead deliveries), so they refuse outright. */ -}}
{{- if and $std.enabled (or (empty $intakePath) (not (hasPrefix "/" $intakePath))) -}}{{ fail "webhook.path must be an absolute request path starting with / (forge deliveries POST there; Gitea/GitLab instances need their canonical /webhooks/<forge> route)" }}{{- end -}}
{{- if and $std.enabled (regexMatch "[[:space:]?#]" $intakePath) -}}{{ fail "webhook.path must not contain whitespace, ?, or # (it becomes an HTTPRoute path match verbatim)" }}{{- end -}}
{{- $normalizedPath := regexReplaceAll "/{2,}" (regexReplaceAll "/+$" $intakePath "" | default "/") "/" -}}
{{- if and $std.enabled (or (eq $normalizedPath "/") (regexMatch "^/(admin|auth|dashboard)(/|$)" $normalizedPath)) -}}{{ fail (printf "webhook.path %s collides with the reserved admin surface (PathPrefix matching is element-based and ignores trailing slashes, so /admin/, /admin/api, and //admin resolve to the reserved admin rules)" $intakePath) }}{{- end -}}
{{- if and $std.enabled (regexMatch "//" $intakePath) -}}{{ fail "webhook.path must not contain empty path segments (//): PathPrefix matching splits on '/', so //hook never matches /hook and the rendered intake rule would be silently dead" }}{{- end -}}
{{- if and $std.enabled (regexMatch "(^|/)\\.\\.?(/|$)" $intakePath) -}}{{ fail "webhook.path must not contain dot segments (. or ..): normalizing infrastructure rewrites such request paths before matching, so the rendered intake rule would be silently dead" }}{{- end -}}
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
{{- /* #1768 review round 2: OIDC material cannot shadow the standard
       selection (the mode itself is refused and the merge forces token
       auth), but a silently discarded credential is a trap — refuse it. */ -}}
{{- if and $std.enabled (or (dig "auth" "oidc" "clientSecret" "" $advanced) (dig "auth" "oidc" "existingSecret" "name" "" $advanced)) -}}{{ fail "controller.admin.auth.oidc client material conflicts with the standard dashboard (standard mode derives token auth)" }}{{- end -}}
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
The standard shared worker/controller storage (#1767), derived from the
single source `controller.persistence`: one entry per standard key, in a
fixed order, each naming the resolved claim and the controller-side root
the runtime contract mounts it at. The claim resolves to the operator's
`existingClaim`, or to the chart-created PVC named by
pr-reviewer.chart-created-claim-name (the common library's own rule,
reproduced so upgrades keep claim names) and pinned with forceRename.
Kubernetes profiles may inherit this artifact's volume mappings when they
omit `volumes`; explicitly declared mappings remain advanced overrides.
Every ambiguous or missing shape fails closed here, in one place.
*/}}
{{- define "pr-reviewer.shared-volume-mappings" -}}
{{- $v := index . "values" -}}
{{- $fullname := index . "fullname" -}}
{{- $mappings := list -}}
{{- range $item := (list (dict "key" "runs" "pathField" "runsRoot") (dict "key" "workspace-cache" "pathField" "workspaceCacheRoot")) -}}
{{- $key := $item.key -}}
{{- $root := index $v.paths $item.pathField -}}
{{- /* Mirror the runtime's mount-root grammar (kubernetesMountRootAt in
       src/config/instance-config.ts) at render time: this artifact is
       what the controller parses into the worker's volume mappings, so a
       malformed root must refuse the render instead of crash-looping the
       deployed controller at startup. */ -}}
{{- if eq $root "/" -}}
{{- fail (printf "controller.paths.%s must not be the filesystem root (it anchors a shared volume mapping)" $item.pathField) -}}
{{- end -}}
{{- if hasSuffix "/" $root -}}
{{- fail (printf "controller.paths.%s must not end with '/'" $item.pathField) -}}
{{- end -}}
{{- if gt (len $root) 4096 -}}
{{- fail (printf "controller.paths.%s must be at most 4096 bytes" $item.pathField) -}}
{{- end -}}
{{- if regexMatch "[[:cntrl:]]" $root -}}
{{- fail (printf "controller.paths.%s must not contain control characters" $item.pathField) -}}
{{- end -}}
{{- $persistence := $v.persistence | default dict -}}
{{- if not (hasKey $persistence $key) -}}
{{- fail (printf "controller.persistence.%s is required as the standard shared storage (or set an explicit advanced topology)" $key) -}}
{{- end -}}
{{- $entry := index $persistence $key -}}
{{- if or (not (kindIs "map" $entry)) (and (hasKey $entry "enabled") (not $entry.enabled)) -}}
{{- fail (printf "controller.persistence.%s is required as the standard shared storage (or set an explicit advanced topology)" $key) -}}
{{- end -}}
{{- $claim := $entry.existingClaim -}}
{{- /* The type guard covers BOTH provisionings: the worker mounts the
       derived mapping by PVC claim name, so an emptyDir/secret entry
       would render the controller a non-PVC volume while the worker
       mounts a claim that does not exist — the two sides would disagree
       about what lives at the shared root. */ -}}
{{- $type := $entry.type | default "persistentVolumeClaim" -}}
{{- if ne $type "persistentVolumeClaim" -}}
{{- fail (printf "controller.persistence.%s must be an operator-provided existingClaim or a chart-created persistentVolumeClaim (standard shared storage; the worker mounts the claim by name)" $key) -}}
{{- end -}}
{{- if empty $claim -}}
{{- /* Resolve the claim with the common library's own naming rules (see
       pr-reviewer.chart-created-claim-name): an operator-set forceRename
       is the rendered name and every derived reference follows it, so
       the artifact, the pin below, and the redeclare guard can never
       drift from the rendered PVC. */ -}}
{{- $claim = include "pr-reviewer.chart-created-claim-name" (dict "values" $v "fullname" $fullname "key" $key "entry" $entry) -}}
{{- end -}}
{{- /* chartCreated is the provisioning fact, not a name shape: an
       operator-provided existingClaim may coincidentally carry the
       chart-created name, and the guards that relax for the legacy
       posture must key on whether the chart actually renders the
       claim. */ -}}
{{- $mappings = append $mappings (dict "key" $key "claim" $claim "controllerRoot" $root "chartCreated" (empty $entry.existingClaim)) -}}
{{- end -}}
{{- /* The two standard storages must resolve to distinct claims: one PVC
       mounted at both roots would alias the runs and workspace-cache
       trees (the mirror's own eviction could then delete live run
       directories). The runtime refuses overlapping ROOTS but cannot see
       a duplicate claim, so the single source refuses here. */ -}}
{{- if and (ge (len $mappings) 2) (eq (index (index $mappings 0) "claim") (index (index $mappings 1) "claim")) -}}
{{- fail (printf "controller.persistence.runs and controller.persistence.workspace-cache both resolve to claim %q; the two standard storages must be distinct claims" (index (index $mappings 0) "claim")) -}}
{{- end -}}
{{- $mappings | toYaml -}}
{{- end -}}

{{/*
Resolve the rendered name of a chart-created standard claim (#1767). This
reproduces the common library's naming for one persistence entry
(determineResourceNameFromValues, fed by lib/pvc/enabledPVCs) exactly, in
its order: an operator-set `forceRename` wins outright; otherwise the
count of chart-created PVC entries decides whether the identifier is
appended (bare fullname for one, `<fullname>-<identifier>` for several —
or always, with `global.alwaysAppendIdentifierToResourceName`), with
`prefix` prepended and `suffix` appended around that. The pre-#1767 chart
let the library name its claims from the same rules, so reproducing them
keeps claim names stable across upgrades: an upgrade that does not change
the storage topology renames nothing — durable state included.
*/}}
{{- define "pr-reviewer.chart-created-claim-name" -}}
{{- $v := index . "values" -}}
{{- $fullname := index . "fullname" -}}
{{- $key := index . "key" -}}
{{- $entry := index . "entry" -}}
{{- /* The library tpl-evaluates values before naming; this resolution
        composes and lowercases the raw strings, so a template inside a
        derived rename field would corrupt the template (and then fail
        the library's own evaluation opaquely). Derived claim names must
        be literal; an existingClaim carries a template-resolved name. */ -}}
{{- range $field := (list "forceRename" "prefix" "suffix") -}}
{{- if contains "{{" (get $entry $field | default "" | toString) -}}
{{- fail (printf "controller.persistence.%s %s must be a literal name (the derived claim resolution does not evaluate templates); use a literal rename or existingClaim (#1767)" $key $field) -}}
{{- end -}}
{{- end -}}
{{- if not (empty $entry.forceRename) -}}
{{- /* the library applies forceRename before every other naming rule */ -}}
{{- $entry.forceRename | lower -}}
{{- else -}}
{{- $enabledPvcs := 0 -}}
{{- range $identifier, $persistenceItem := ($v.persistence | default dict) -}}
{{- if kindIs "map" $persistenceItem -}}
{{- $pvcEnabled := true -}}
{{- if hasKey $persistenceItem "enabled" -}}
{{- $pvcEnabled = $persistenceItem.enabled -}}
{{- end -}}
{{- if and $pvcEnabled (eq ($persistenceItem.type | default "persistentVolumeClaim") "persistentVolumeClaim") (empty $persistenceItem.existingClaim) -}}
{{- $enabledPvcs = add1 $enabledPvcs -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $appendIdentifier := or (gt $enabledPvcs 1) (dig "alwaysAppendIdentifierToResourceName" false ($v.global | default dict)) -}}
{{- $name := $fullname -}}
{{- if not (empty $entry.prefix) -}}
{{- if not (eq $name $entry.prefix) -}}
{{- $name = printf "%s-%s" $entry.prefix $name -}}
{{- end -}}
{{- end -}}
{{- if $appendIdentifier -}}
{{- if and (not (hasSuffix (printf "-%s" $key) $name)) (ne $key $name) -}}
{{- $name = printf "%s-%s" $name $key -}}
{{- end -}}
{{- end -}}
{{- if not (empty $entry.suffix) -}}
{{- if not (hasSuffix (printf "-%s" $entry.suffix) $name) -}}
{{- $name = printf "%s-%s" $name $entry.suffix -}}
{{- end -}}
{{- end -}}
{{- /* the common library lowercases rendered object names */ -}}
{{- $name | lower -}}
{{- end -}}
{{- end -}}

{{/*
Validate the controller wiring fail-closed at render time and inject the
template-conditional pieces (env, probes, rendered Secrets, persistence)
into the component values before the common library renders. Signature:
dict "ctx" <component context> "root" <chart root>
"workerExecutorKubernetes" <bool> "workerExecutor" <map>.
*/}}
{{- define "pr-reviewer.controller.configure" -}}
{{- $ctx := index . "ctx" -}}
{{- $root := index . "root" -}}
{{- $kubeExecutor := index . "workerExecutorKubernetes" -}}
{{- $workerExecutor := index . "workerExecutor" -}}
{{- $v := $ctx.Values -}}
{{- $fullname := include "pr-reviewer.fullname" $ctx | lower -}}
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
{{- $_ := set $v "service" (mustMergeOverwrite ($v.service | default dict) (dict "webhook" (dict "enabled" true "type" "ClusterIP" "forceRename" $stdWebhook.serviceName "controller" "main" "ports" (dict "webhook" (dict "port" $stdWebhook.port))))) -}}
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

{{- /* #1762: the controller image is the chart's own default, not required
       operator boilerplate: values.yaml carries the canonical repository,
       and an unset tag resolves to Chart.appVersion here because the
       common library requires an explicit tag or digest and never consults
       appVersion itself (its own validation still fails closed if an
       operator blanks repository, or both tag and digest). An explicit
       operator tag wins outright; an explicit digest alone is a complete
       pin (the library renders repository@digest). This mirrors the
       worker-image resolution in pr-reviewer.worker-deployment-image, and
       runs before the common library renders, so the fix-roots init
       container below inherits the resolved image. The map guard keeps a
       string-shaped image (never supported) failing with the library's
       own actionable message instead of a field access on a string. */ -}}
{{- $controllerImage := dig "controllers" "main" "containers" "main" "image" dict $v -}}
{{- if and (kindIs "map" $controllerImage) (empty $controllerImage.tag) (empty $controllerImage.digest) -}}
{{- $_ := set $controllerImage "tag" $ctx.Chart.AppVersion -}}
{{- end -}}

{{- /* fail closed on incomplete wiring — the daemon would refuse anyway */ -}}
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
{{- /* The two shared payload roots must not overlap — the runtime refuses
       overlapping controller roots in the volume mappings it parses
       (one path matching two mappings is a config bug), so the single
       source refuses the same shape at render time. */ -}}
{{- if and (index $paths "runsRoot") (index $paths "workspaceCacheRoot") (or (eq (index $paths "runsRoot") (index $paths "workspaceCacheRoot")) (hasPrefix (printf "%s/" (index $paths "runsRoot")) (index $paths "workspaceCacheRoot")) (hasPrefix (printf "%s/" (index $paths "workspaceCacheRoot")) (index $paths "runsRoot"))) -}}
{{- fail "controller.paths.runsRoot and controller.paths.workspaceCacheRoot overlap; each shared storage must anchor at its own root (the runtime refuses overlapping volume-mapping roots)" -}}
{{- end -}}
{{- /* Chart-created claim names resolve from the fullname the common
        library's PVC naming used pre-#1767
        (bjw-s.common.lib.chart.names.fullname): global overrides win over
        the component ones, then the release containment chain. The
        chart's other objects keep naming from the pr-reviewer.fullname
        mirror, which deliberately ignores the global overrides — a claim
        name that followed the mirror would silently rename the claims an
        override install already has, and Helm would delete the old
        claims on upgrade. */ -}}
{{- $claimName := dig "nameOverride" "" ($v.global | default dict) | default ($v.nameOverride | default $ctx.Chart.Name) -}}
{{- $claimFullname := dig "fullnameOverride" "" ($v.global | default dict) | default $v.fullnameOverride -}}
{{- if empty $claimFullname -}}
{{- $claimName = $claimName | toString | trunc 63 | trimSuffix "-" -}}
{{- if contains $claimName $ctx.Release.Name -}}
{{- $claimFullname = $ctx.Release.Name -}}
{{- else -}}
{{- $claimFullname = printf "%s-%s" $ctx.Release.Name $claimName -}}
{{- end -}}
{{- end -}}
{{- $claimFullname = $claimFullname | toString | trunc 63 | trimSuffix "-" -}}
{{- $mappings := include "pr-reviewer.shared-volume-mappings" (dict "values" $v "fullname" $claimFullname) | fromYamlArray -}}
{{- $sharedVolumesJson := "" -}}
{{- if $kubeExecutor -}}
{{- $sharedVolumes := list -}}
{{- range $mapping := $mappings -}}
{{- $sharedVolumes = append $sharedVolumes (dict "claim" $mapping.claim "controllerRoot" $mapping.controllerRoot) -}}
{{- end -}}
{{- $sharedVolumesJson = $sharedVolumes | toJson -}}
{{- end -}}
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
{{- /* Pin the chart-created claim name to the resolution the artifact
        derived (the common library's own naming rule, reproduced by
        pr-reviewer.chart-created-claim-name): pinning keeps the rendered
        PVC name deterministic against the derived references even if the
        library's rule changes upstream. The chart renders this claim
        itself, so a same-named workerExecutor.volumeClaims entry would
        render a second PVC. When the operator provides the claim via
        existingClaim, a matching volumeClaim is its provisioner (the
        pre-#1767 documented posture) and stays allowed. */ -}}
{{- $_ := set $entry "forceRename" $mapping.claim -}}
{{- range $claim := ($workerExecutor.volumeClaims | default list) -}}
{{- if eq ($claim.name | lower) $mapping.claim -}}
{{- fail (printf "workerExecutor.volumeClaims must not redeclare the chart-created standard claim %q (derived from controller.persistence.%s, #1767); volumeClaims is for additional non-standard claims, or for provisioning a claim named by controller.persistence.*.existingClaim" $mapping.claim $mapping.key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- /* Durable state must survive chart upgrades and uninstalls. Its name
        resolves with the same rule the common library names every PVC
        from (pr-reviewer.chart-created-claim-name), because the
        pre-#1767 chart let that rule name the claim too: an upgrade that
        keeps the storage topology keeps the exact claim name — a single
        chart-created PVC renders the bare fullname (the documented
        pre-#1767 example posture), several render
        <fullname>-durable-state (the controller-only defaults and the
        chart-created shared-claims topology). A per-mode pin would
        silently rename one of those postures on upgrade and Helm would
        delete the old claim with the audit ledger and queue snapshot.
        An operator-set existingClaim or forceRename wins — that is the
        explicit way to keep a name across a deliberate topology change
        (the adoption path documents it). retain keeps the PVC on
        uninstall and, for installs first rendered by this chart, across
        any later rename. */ -}}
{{- $durableState := index ($v.persistence | default dict) "durable-state" | default dict -}}
{{- if empty $durableState.existingClaim -}}
{{- if empty $durableState.forceRename -}}
{{- $_ := set $durableState "forceRename" (include "pr-reviewer.chart-created-claim-name" (dict "values" $v "fullname" $claimFullname "key" "durable-state" "entry" $durableState)) -}}
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
{{- /* The namespace guards fire only when the chart actually derives
       shared claims. With an all-existingClaim posture the operator
       provisions identical claims in every namespace the topology names
       (the pre-#1767 dedicated-worker-namespace shape), and that posture
       must keep rendering — there is no chart-created claim the single
       source could orphan. When ANY standard claim is chart-created,
       PVCs are namespace-scoped and the chart derives the claims once,
       in the release namespace, so every namespace in the topology must
       be the release namespace. workerExecutor.namespace is the
       provisioning mirror; when the instance config is inline the chart
       also checks its authoritative executor namespace (an opaque
       existingSecret cannot be checked and stays the operator's
       documented responsibility). */ -}}
{{- $chartCreatesShared := false -}}
{{- range $mapping := $mappings -}}
{{- if $mapping.chartCreated -}}
{{- $chartCreatesShared = true -}}
{{- end -}}
{{- end -}}
{{- if $chartCreatesShared -}}
{{- if ne (default $ctx.Release.Namespace $workerExecutor.namespace) $ctx.Release.Namespace -}}
{{- fail (printf "shared claims are namespace-scoped and the chart derives them once, in the release namespace %q; standard topology requires workerExecutor.namespace %q to equal the release namespace" $ctx.Release.Namespace $workerExecutor.namespace) -}}
{{- end -}}
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
       that drift refuses the render. The root check applies to the
       default executor profile only: when the instance config declares
       default-executor-profile AND that name is a kubernetes profile,
       profiles it does not name are advanced operator material whose raw
       mappings stay supported unchecked; a declared default that is
       missing or not a kubernetes profile must not silently uncheck the
       kubernetes profiles (the runtime refuses an unknown default at
       startup, but the render refuses first), so without a trusted
       default every kubernetes profile is checked. The claim NAME is operator-owned
       and stays unverified: a stale name after a release-name change or
       an existingClaim rename is indistinguishable from a mapping on a
       non-standard claim (volumeClaims-provisioned or operator-managed),
       which stays supported. Profiles may omit `volumes` to inherit this
       artifact's mappings automatically; declared volumes remain the
       advanced override whose derived roots this check keeps honest. */ -}}
{{- $rootByClaim := dict -}}
{{- range $mapping := $mappings -}}
{{- $_ := set $rootByClaim ($mapping.claim | lower) $mapping.controllerRoot -}}
{{- end -}}
{{- $defaultProfile := index $instanceCfg "default-executor-profile" | default "" -}}
{{- $kubeProfileNames := list -}}
{{- range $p := (index $instanceCfg "executor-profiles" | default list) -}}
{{- if and (kindIs "map" $p) (kindIs "map" (index $p "kubernetes" | default dict)) -}}
{{- $kubeProfileNames = append $kubeProfileNames (index $p "name" | default "") -}}
{{- end -}}
{{- end -}}
{{- $defaultTrusted := and (not (empty $defaultProfile)) (has $defaultProfile $kubeProfileNames) -}}
{{- range $profile := (index $instanceCfg "executor-profiles" | default list) -}}
{{- if kindIs "map" $profile -}}
{{- $kubeProfile := index $profile "kubernetes" | default dict -}}
{{- if and $chartCreatesShared (kindIs "map" $kubeProfile) (not (empty $kubeProfile.namespace)) (ne $kubeProfile.namespace $ctx.Release.Namespace) -}}
{{- fail (printf "instance config executor-profiles.kubernetes.namespace %q must equal the release namespace %q: the standard shared claims are derived in the release namespace and PVCs are namespace-scoped (#1767)" $kubeProfile.namespace $ctx.Release.Namespace) -}}
{{- end -}}
{{- $enforceRoot := or (not $defaultTrusted) (eq (index $profile "name" | default "") $defaultProfile) -}}
{{- if and $enforceRoot (kindIs "map" $kubeProfile) -}}
{{- range $volume := (index $kubeProfile "volumes" | default list) -}}
{{- if and (kindIs "map" $volume) (not (empty $volume.claim)) -}}
{{- $derivedRoot := index $rootByClaim ($volume.claim | lower) -}}
{{- $declaredRoot := index $volume "controller-root" | default "" -}}
{{- if and (not (empty $derivedRoot)) (ne $declaredRoot $derivedRoot) -}}
{{- fail (printf "instance config executor-profiles.kubernetes volumes claim %q must mount at the derived controller root %q (single source: controller.persistence claim and controller.paths root, #1767); a profile that omits volumes inherits the derived mappings, so an explicitly declared derived claim must not diverge" $volume.claim $derivedRoot) -}}
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
{{- $_ := set $container "env" (include "pr-reviewer.controller.env" (dict "ctx" $ctx "root" $root "workerExecutorKubernetes" $kubeExecutor "sharedVolumesJson" $sharedVolumesJson) | fromYamlArray) -}}
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
