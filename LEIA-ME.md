# Área das Famílias – versão com loja (Profª Ana Clara)

Site novo, separado do original (`ana0104/prof.ana` não foi alterado).

- `site/` – o que vai para o Netlify (portal em `/`, loja em `/loja`, painel em `/loja/painel.html`)
- `supabase/functions/` – funções `acesso` (portal e painel) e `loja` (Mercado Pago e lembretes)
- `supabase/migracoes/` – banco, na ordem em que foi aplicado no projeto `area-familias-loja`

Segredos das funções (Supabase → Edge Functions → Secrets):
`SITE_URL`, `MP_ACCESS_TOKEN`, `CALLMEBOT_APIKEY`, `PAINEL_SENHA`.
