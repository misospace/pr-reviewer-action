# Chart examples

Each example is a complete (or layerable) values file. Secrets are NEVER
put in values — the placeholder manifests below create the prerequisite
Secrets in the release namespace first.

## Install

```sh
# 1. Prerequisite Secrets (edit the placeholder data).
kubectl apply -f secrets.yaml

# 2. The chart (controller-only example).
helm dependency build deploy/charts/pr-reviewer
helm install pr-reviewer deploy/charts/pr-reviewer \
  -f deploy/charts/pr-reviewer/examples/values-controller-only.yaml
```

For the Kubernetes worker executor, layer the executor example (it
provisions the worker namespace's service account, the namespace-scoped
Role/RoleBinding, and the shared PVCs; the worker Jobs themselves are
created by the controller's executor from the instance config):

```sh
helm install pr-reviewer deploy/charts/pr-reviewer \
  -f deploy/charts/pr-reviewer/examples/values-kubernetes-executor.yaml
```

Point at external PostgreSQL (never deployed by this chart):

```sh
helm install pr-reviewer deploy/charts/pr-reviewer \
  -f deploy/charts/pr-reviewer/examples/values-controller-only.yaml \
  -f deploy/charts/pr-reviewer/examples/values-external-postgres.yaml
```

Run the dashboard with OIDC sign-in (Authorization Code + PKCE) instead of
the pasted admin token. The example references an operator-provided Secret
for the OIDC client secret; create it alongside the other prerequisite
Secrets:

```sh
helm install pr-reviewer deploy/charts/pr-reviewer \
  -f deploy/charts/pr-reviewer/examples/values-admin-oidc.yaml
```

## Standard mode

Layer the standard exposure values over the Kubernetes-executor example. The referenced webhook and admin Secrets are listed below.

```sh
helm install pr-reviewer deploy/charts/pr-reviewer \
  -f deploy/charts/pr-reviewer/examples/values-kubernetes-executor.yaml \
  -f deploy/charts/pr-reviewer/examples/values-standard.yaml
```

## Prerequisite Secrets

### Forgejo instance (`values-controller-only.yaml`)

```yaml
---
apiVersion: v1
kind: Secret
metadata:
  name: pr-reviewer-instance-config
  namespace: pr-reviewer
stringData:
  # Full schema: docs/operator-config-and-adoption.md
  instance-config.yaml: |
    version: 1
    forges:
      - name: forge
        kind: forgejo
        endpoint: https://git.example.com
        credential: forge-token
    model-profiles:
      - name: local-fast
        endpoint: https://model-endpoint.example.com/v1
        api-format: openai
        credential: model-key
        model: <model-id>
    default-model-profile: local-fast
    executor-profiles:
      - name: in-process
        kind: local
        local:
          command: node
          args: ["/app/dist/index.js", "worker"]
    default-executor-profile: in-process
    evidence-profiles:
      - name: default
        providers-file: /config/evidence-providers.json
    default-evidence-profile: default
---
apiVersion: v1
kind: Secret
metadata:
  name: pr-reviewer-control-plane
  namespace: pr-reviewer
stringData:
  dsn: postgresql://pr_reviewer:REPLACE_ME@postgres.example.com:5432/pr_reviewer
---
apiVersion: v1
kind: Secret
metadata:
  name: forgejo-webhook-secret
  namespace: pr-reviewer
stringData:
  webhook-secret: REPLACE_ME
---
apiVersion: v1
kind: Secret
metadata:
  name: forgejo-token
  namespace: pr-reviewer
stringData:
  token: REPLACE_ME
---
apiVersion: v1
kind: Secret
metadata:
  name: pr-reviewer-admin
  namespace: pr-reviewer
stringData:
  token: REPLACE_ME
---
apiVersion: v1
kind: Secret
metadata:
  name: model-credentials
  namespace: pr-reviewer
stringData:
  model-key: REPLACE_ME
```

### GitHub App instance (`values-kubernetes-executor.yaml`)

```yaml
---
apiVersion: v1
kind: Secret
metadata:
  name: pr-reviewer-control-plane
  namespace: pr-reviewer
stringData:
  dsn: postgresql://pr_reviewer:REPLACE_ME@postgres.example.com:5432/pr_reviewer
---
apiVersion: v1
kind: Secret
metadata:
  name: github-webhook-secret
  namespace: pr-reviewer
stringData:
  webhook-secret: REPLACE_ME
---
# The GitHub App's PEM private key. The key NAME in the Secret becomes
# the mounted file name; the chart points
# PR_REVIEWER_GITHUB_APP_PRIVATE_KEY_FILE at it.
apiVersion: v1
kind: Secret
metadata:
  name: github-app-private-key
  namespace: pr-reviewer
stringData:
  private-key.pem: |
    -----BEGIN PRIVATE KEY-----
    REPLACE_ME
    -----END PRIVATE KEY-----
---
apiVersion: v1
kind: Secret
metadata:
  name: model-credentials
  namespace: pr-reviewer
stringData:
  model-key: REPLACE_ME
```

## PR discovery without webhooks

The polling-first chart default runs every 900000 ms (15 minutes) once you
configure `controller.reconcile.repos` and, for GitHub, the corresponding
`controller.reconcile.githubInstallationId`. A repo list with no installation
identity is rejected for GitHub; an empty repo list scans nothing.
`controller.webhook.enabled: false` is supported: webhook delivery is only
an optional lower-latency path. Override `controller.reconcile.intervalMs`
for another interval, or set `controller.reconcile.enabled: false` to opt out.
A first sweep can enqueue already-open PRs; bound rollout/model spending
accordingly.

## Notes

- The instance config must declare forges for exactly ONE platform per
  instance; run one controller instance per forge platform.
- `PR_REVIEWER_CREDENTIAL_<REF>` material is provided through
  `controller.credentials` (each reference the model profiles name).
  `<REF>` is the reference uppercased with every non-alphanumeric
  character mapped to `_` — the runtime's `credentialEnvName`
  derivation — so the reference `model-key` is provided as
  `PR_REVIEWER_CREDENTIAL_MODEL_KEY`.
- The admin listener is served on `controller.admin.port`, guarded by the
  admin bearer token and bound pod-wide (`PR_REVIEWER_ADMIN_BIND=0.0.0.0`)
  when enabled; `kubectl exec` + loopback also works for local debugging.
- The chart's `networkPolicy.enabled` defaults to `false`. Only explicitly
  enable it after configuring controller/worker ingress and egress for your
  cluster, including the Kubernetes API, model endpoint and admin listener.
  With policies enabled the webhook intake permits ingress on its port;
  operator-specific exceptions go in `networkPolicy.additionalIngress`.
- The **workers**, not only the controller, must reach the model
  endpoint: the worker pod runs the review engine and calls the model
  API itself. The default worker policy allows DNS and TLS (443) only,
  so a plain-HTTP in-cluster endpoint needs
  `networkPolicy.workerAdditionalEgress` (#1709), for example:

  ```yaml
  networkPolicy:
    enabled: true
    workerAdditionalEgress:
      - to:
          - namespaceSelector:
              matchLabels:
                kubernetes.io/metadata.name: llm
            podSelector:
              matchLabels:
                app.kubernetes.io/name: litellm
        ports:
          - protocol: TCP
            port: 4000
  ```

  These rules render only into the worker policy. `additionalEgress`
  stays controller-only, and the worker default stays DNS + TLS without
  the override.
