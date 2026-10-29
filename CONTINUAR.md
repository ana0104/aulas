# Como continuar – Área das Famílias com loja (Profª Ana Clara)

## O que já está pronto (neste zip)
- `site/index.html` – portal das famílias (o mesmo visual do original).
- `site/loja/index.html` – loja: nome, e-mail e WhatsApp da mãe → paga R$ 40/mês com Pix ou cartão (Mercado Pago).
- `site/loja/painel.html` – painel da professora (senha): códigos pendentes, famílias, aparelhos, enviar atividades (.html), cadastro manual.
- `supabase/functions/acesso/index.ts` – portal + painel.
- `supabase/functions/loja/index.ts` – Mercado Pago (compra, aviso de pagamento) + lembrete diário.
- `supabase/migracoes/01…05.sql` – banco, aplicar nessa ordem.

## Como funciona
1. A mãe paga na loja → a família é cadastrada sozinha com acesso por 1 mês (renovação soma +1 mês).
2. No portal, a mãe digita e-mail + WhatsApp da compra e marca "este é o aparelho de estudos".
3. O código de 6 números vai para o WhatsApp da professora (+55 11 97628-0903) pelo CallMeBot, junto com o e-mail e o WhatsApp da mãe e um link que abre a conversa com ela já com o código escrito.
4. Limite de 2 aparelhos por família. Com as 2 vagas ocupadas, nem gera código: aparece "fale com a professora". A professora troca (Tirar) ou dá mais vagas (+) no painel.
5. A professora recebe no WhatsApp: cada venda/renovação e, todo dia às 9h, quem vence em 3 dias ou venceu ontem (com link pronto para cobrar).
6. `COM_CODIGO = true` no topo de `acesso/index.ts`. Com `false`, o aparelho entra direto, sem código (até o limite).

## Situação
- Testado no servidor: compra paga, renovação, aviso repetido do Mercado Pago, WhatsApp errado, código certo, 3º aparelho barrado e mensalidade vencida. Tudo funcionou.
- Ainda não testado: pagamento real no Mercado Pago e mensagem chegando de verdade no WhatsApp.
- Um projeto de teste foi criado por engano na conta do Daniel (organização "Club do Chopp", projeto `area-familias-loja`). Já está **pausado**. O Daniel pode apagar em Project Settings → General → Delete project. O projeto club-do-chopp não foi tocado.
- O site original (`ana0104/prof.ana` e o Supabase do portal atual) **não foi alterado e não deve ser alterado**.

## Feito em 29/10/2026
1. Projeto `area-familias-loja` (ref `spbyexrqtzxildwjhcec`, São Paulo) na organização separada "Profª Ana Clara – Loja".
2. Migrações 01→05 aplicadas; funções `acesso` e `loja` publicadas com verificação JWT desligada; agendador das 9h apontando para o projeto novo.
3. `SUPABASE_URL` trocado nos 3 arquivos de `site/` e na migração 05; zip do Netlify gerado.
4. Testado pelo servidor: entrada com código (errado/certo/reuso), WhatsApp errado, 3º aparelho barrado, mensalidade vencida, venda nova, renovação e lembretes.

## Próximos passos
4. Professora: publicar no Netlify (projeto novo), criar o Access Token de produção do Mercado Pago e a apikey do CallMeBot.
5. Segredos das funções: `SITE_URL`, `MP_ACCESS_TOKEN`, `CALLMEBOT_APIKEY` e `PAINEL_SENHA` (8+ caracteres). Nunca colar no chat.
6. Testar: botão "Testar WhatsApp" no painel, enviar uma atividade e fazer uma compra real de R$ 40.
