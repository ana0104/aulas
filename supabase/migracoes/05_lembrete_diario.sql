-- Configurações internas (só o servidor lê)
create table public.configuracao (
  chave text primary key,
  valor text not null
);
alter table public.configuracao enable row level security;
revoke all on public.configuracao from anon, authenticated;

insert into public.configuracao (chave, valor)
values ('lembrete_chave', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (chave) do nothing;

-- Todo dia às 9h de Brasília (12h UTC) a loja manda para a professora quem vence em 3 dias e quem venceu ontem
select cron.schedule(
  'lembretes-mensalidade',
  '0 12 * * *',
  $$
  select net.http_post(
    url := 'https://spbyexrqtzxildwjhcec.supabase.co/functions/v1/loja',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('acao', 'lembretes', 'chave', (select valor from public.configuracao where chave = 'lembrete_chave'))
  );
  $$
);
