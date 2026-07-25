# n8n-Scheduler: Optimize-Loop

Import: In n8n „Workflow → Import from File“ wählen und `optimize-loop.json` laden.
Danach im HTTP-Node zwei Platzhalter ersetzen: `{BASE_URL}` durch die Deploy-URL
der App (SPEC §7b) und `{SECRET}` durch den Wert von `ADLOOP_ADMIN_SECRET`
(nur in n8n eintragen, nie ins Repo). Der Workflow feuert stündlich
`POST /api/brands/loyft/optimize` und bleibt bis zur manuellen Aktivierung inaktiv.
