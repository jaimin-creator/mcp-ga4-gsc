# Déploiement worker MCP GA4 + Search Console

État au 18 mai 2026, ce qui est fait et ce qui reste pour que le worker soit live.

## Ce qui est déjà fait (en autonomie)

### Google Cloud (projet `rablab-mcp`)
- 3 APIs activées : Google Analytics Admin API, Google Analytics Data API, Google Search Console API
- OAuth Consent Screen configuré en External + Testing (par toi avant)
- Compte actif : `ppc.rablab@gmail.com` (authuser=1 dans l'URL)

### Cloudflare
- Account ID : `8f873876f6a5c1875b3b12dced29b1af`
- KV namespace créé : `OAUTH_KV` (id `2efa2ad87fad44b6933a7d62076e0f7e`)
- Worker à venir : `mcp-ga4-gsc.rablab.workers.dev`

### Code worker (dans `/MCP - DataForSEO/ga4-gsc-worker/`)
- Forké depuis bighadj22/cloudflare-mcp-google-oauth-analytics
- Remplacé `mcp-analytics` (package dépublié) par `agents/mcp` natif
- Scope OAuth Google passé de `email profile` à `openid email profile analytics.readonly webmasters.readonly`
- 8 outils exposés : `ga4_list_account_summaries`, `ga4_get_property_details`, `ga4_run_report`, `ga4_run_realtime_report`, `gsc_list_sites`, `gsc_query_search_analytics`, `gsc_list_sitemaps`, `gsc_inspect_url`
- Type-check OK, dry-run deploy OK (1.2 MiB, 229 KiB gzip)
- `wrangler.jsonc` à jour avec le KV ID

## Ce qui reste (10 minutes manuel)

### 1, Créer le OAuth Client Web Application (Google Cloud)

L'onglet est déjà ouvert dans Chrome sur la bonne page. Sinon : https://console.cloud.google.com/auth/clients/create?authuser=1&project=rablab-mcp

Remplir le formulaire :
- Type d'application : `Application Web`
- Nom : `Rablab GA4 + GSC MCP`
- URI de redirection autorisé : `https://mcp-ga4-gsc.rablab.workers.dev/callback`
- (Optionnel pour dev local) ajouter aussi : `http://localhost:8788/callback`
- Cliquer `Créer`

Une popup affiche le `Client ID` et le `Client Secret`. **Copier les deux** quelque part de sécurisé (1Password Rablab par exemple).

### 2, Ajouter les utilisateurs testers

https://console.cloud.google.com/auth/audience?authuser=1&project=rablab-mcp

Cliquer `Add users`, ajouter :
- `julien.c@rablab.ca`
- `ppc.rablab@gmail.com`
- Et tous les emails Rablab qui doivent utiliser le worker (max 100)

### 3, Setter les secrets dans Cloudflare et déployer

Depuis un terminal local, dans le dossier du worker :

```bash
cd "/Users/rabacademie/Documents/Claude/Projects/MCP - DataForSEO/ga4-gsc-worker"

# Login Cloudflare (ouvre une page dans Chrome, valider)
npx wrangler login

# Setter les 3 secrets
npx wrangler secret put GOOGLE_CLIENT_ID
# (coller le Client ID puis Enter)

npx wrangler secret put GOOGLE_CLIENT_SECRET
# (coller le Client Secret puis Enter)

npx wrangler secret put COOKIE_ENCRYPTION_KEY
# (coller une string aléatoire, par exemple le résultat de : openssl rand -hex 32)

# Optionnel pour restreindre à un domaine Workspace (pas notre cas, on est Gmail) :
npx wrangler secret put HOSTED_DOMAIN
# (coller une string vide, juste Enter)

# Déployer
npx wrangler deploy
```

Le worker sera live à `https://mcp-ga4-gsc.rablab.workers.dev`.

### 4, Tester avec MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Ouvrir http://localhost:5173. Connecter à `https://mcp-ga4-gsc.rablab.workers.dev/sse` en mode SSE. Le navigateur va ouvrir un flow OAuth Google : approuver les permissions analytics.readonly + webmasters.readonly. Une fois OK, tester les outils :

- `gsc_list_sites` (no args) doit lister les propriétés Search Console accessibles
- `ga4_list_account_summaries` (no args) doit lister les comptes GA4
- `gsc_query_search_analytics` avec `site_url: "https://www.guillevin.com/"`, `start_date: "2026-04-01"`, `end_date: "2026-04-30"`, `dimensions: ["query"]`, `row_limit: 10` doit retourner les top queries Guillevin du mois

### 5, Connecter dans Claude Desktop / Cowork

Dans `~/Library/Application Support/Claude/claude_desktop_config.json` (ou via l'UI Claude Desktop) :

```json
{
  "mcpServers": {
    "ga4-gsc-rablab": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp-ga4-gsc.rablab.workers.dev/sse"]
    }
  }
}
```

Restart Claude Desktop. Le worker apparaît dans la liste des MCPs. Premier appel = OAuth flow.

## Diffusion à Rablab

Pour que tous les membres Rablab utilisent le worker, partager l'URL `https://mcp-ga4-gsc.rablab.workers.dev/sse` et leur faire ajouter la config Claude Desktop ci-dessus. Chaque utilisateur fait son OAuth flow avec son propre compte Google (donc accès uniquement aux propriétés GA4 et GSC où il a déjà les droits).

Limite testers : 100 max en mode Testing. Au-delà, faire la vérification Google (ça prend 2-4 semaines).

## En cas de souci

Logs du worker en temps réel :
```bash
npx wrangler tail mcp-ga4-gsc
```

Tester les outils GA4 directement en HTTP :
```bash
curl -X POST "https://analyticsdata.googleapis.com/v1beta/properties/PROPERTY_ID:runReport" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dateRanges":[{"startDate":"30daysAgo","endDate":"yesterday"}],"metrics":[{"name":"sessions"}]}'
```
