import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// CONFIGURAÇÃO
// ============================================================
const PRECO = 40;                                        // reais por mês
const PRODUTO = "Atividades da Profª Ana Clara – 1 mês"; // aparece na tela do Mercado Pago
// Endereço do site no Netlify, ex.: https://atividades-profana.netlify.app (vem do segredo SITE_URL)
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "");
const PORTAL_URL = SITE_URL + "/";
const LOJA_URL = SITE_URL + "/loja";
const WHATSAPP_PROFESSORA = "5511976280903";             // recebe os avisos (precisa do segredo CALLMEBOT_APIKEY)
const MAX_COMPRAS_HORA = 10;                             // pedidos de compra por internet (IP) em 1h

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const MP = "https://api.mercadopago.com";

function resposta(dados: unknown, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function erro(mensagem: string, status = 400) {
  return resposta({ erro: mensagem }, status);
}

function ipDe(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
}

function hojeEmBrasilia(maisDias = 0) {
  return new Date(Date.now() + maisDias * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function dataBR(iso: string) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

function mercadoPago(caminho: string, init: RequestInit = {}) {
  return fetch(MP + caminho, {
    ...init,
    headers: {
      Authorization: `Bearer ${Deno.env.get("MP_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

// "(11) 97628-0903" vira "5511976280903". Devolve "" se não parecer um celular.
function soNumeros(telefone: string) {
  let n = String(telefone ?? "").replace(/\D/g, "");
  if (n.length === 10 || n.length === 11) n = "55" + n;
  return /^55\d{10,11}$/.test(n) ? n : "";
}

function linkWhats(numero: string | null, texto: string) {
  return numero ? `https://wa.me/${numero}?text=${encodeURIComponent(texto)}` : "(sem WhatsApp)";
}

// Manda uma mensagem no WhatsApp da professora pelo CallMeBot.
async function avisarProfessora(texto: string) {
  const chave = Deno.env.get("CALLMEBOT_APIKEY");
  if (!chave) {
    console.error("CallMeBot: falta o segredo CALLMEBOT_APIKEY");
    return false;
  }
  try {
    const url = "https://api.callmebot.com/whatsapp.php?phone=" + WHATSAPP_PROFESSORA +
      "&apikey=" + encodeURIComponent(chave) + "&text=" + encodeURIComponent(texto);
    const r = await fetch(url);
    if (!r.ok) console.error("CallMeBot", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("CallMeBot", e);
    return false;
  }
}

// ---------- 1. A mãe toca em "Pagar" ----------
// deno-lint-ignore no-explicit-any
async function comprar(corpo: any, req: Request) {
  if (!SITE_URL.startsWith("https://") || !Deno.env.get("MP_ACCESS_TOKEN")) {
    console.error("Configuração incompleta: confira os segredos SITE_URL e MP_ACCESS_TOKEN");
    return erro("A loja ainda está sendo configurada. Fale com a professora.", 503);
  }
  const email = String(corpo.email ?? "").trim().toLowerCase();
  const nome = String(corpo.nome ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  const whatsapp = soNumeros(corpo.whatsapp);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return erro("Confira o e-mail.");
  if (nome.length < 3) return erro("Escreva o nome da família.");
  if (!whatsapp) return erro("Confira o WhatsApp (com DDD).");

  const ip = ipDe(req);
  if (ip) {
    const { count } = await db
      .from("compras")
      .select("id", { count: "exact", head: true })
      .eq("ip", ip)
      .gte("criado_em", new Date(Date.now() - 3600000).toISOString());
    if ((count ?? 0) >= MAX_COMPRAS_HORA) return erro("Muitas tentativas. Espere um pouco e tente de novo.");
  }

  // Quem já é cliente mantém o nome que já aparece nas atividades
  const { data: existente } = await db.from("familias").select("nome").eq("email", email).maybeSingle();

  const { data: compra, error } = await db
    .from("compras")
    .insert({ nome: existente?.nome ?? nome, email, whatsapp, valor: PRECO, ip })
    .select("id")
    .single();
  if (error) throw error;

  const volta = `${LOJA_URL}/?compra=${compra.id}`;
  const r = await mercadoPago("/checkout/preferences", {
    method: "POST",
    body: JSON.stringify({
      items: [{ id: "mensal", title: PRODUTO, quantity: 1, unit_price: PRECO, currency_id: "BRL" }],
      payer: { email },
      external_reference: compra.id,
      back_urls: { success: volta, pending: volta, failure: volta },
      auto_return: "approved",
      notification_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/loja?webhook=1`,
      payment_methods: { excluded_payment_types: [{ id: "ticket" }], installments: 1 }, // só Pix e cartão
      statement_descriptor: "PROF ANA CLARA",
    }),
  });
  const pref = await r.json().catch(() => ({}));
  if (!r.ok || !pref.init_point) {
    console.error("Mercado Pago", r.status, JSON.stringify(pref));
    return erro("Não consegui abrir o pagamento agora. Tente de novo em instantes.", 502);
  }

  return resposta({ compra_id: compra.id, url: pref.init_point });
}

// ---------- 2. A loja pergunta se o pagamento já caiu ----------
// deno-lint-ignore no-explicit-any
async function status(corpo: any) {
  const id = String(corpo.compra_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return erro("Compra não encontrada.", 404);
  const { data: compra } = await db
    .from("compras")
    .select("status, email, familia:familias(acesso_ate)")
    .eq("id", id)
    .maybeSingle();
  if (!compra) return erro("Compra não encontrada.", 404);
  return resposta({
    status: compra.status,
    email: compra.email,
    // deno-lint-ignore no-explicit-any
    acesso_ate: (compra.familia as any)?.acesso_ate ?? null,
    portal: PORTAL_URL,
  });
}

// ---------- 3. O Mercado Pago avisa que um pagamento mudou ----------
// O aviso em si não é confiável: o pagamento é sempre conferido direto no Mercado Pago.
async function webhook(req: Request) {
  const url = new URL(req.url);
  // deno-lint-ignore no-explicit-any
  let corpo: any = {};
  try { corpo = await req.json(); } catch { /* alguns avisos vêm sem corpo */ }

  const tipo = url.searchParams.get("type") ?? url.searchParams.get("topic") ?? corpo.type ?? corpo.topic;
  const pagamentoId = url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? corpo?.data?.id;
  if (tipo !== "payment" || !pagamentoId || !/^\d+$/.test(String(pagamentoId))) {
    return resposta({ ok: true, ignorado: true });
  }

  const r = await mercadoPago(`/v1/payments/${pagamentoId}`);
  if (!r.ok) {
    console.error("Mercado Pago", r.status, await r.text());
    return erro("Falha ao consultar o pagamento.", 500); // o Mercado Pago tenta de novo depois
  }
  const pg = await r.json();

  if (pg.status !== "approved") return resposta({ ok: true, status: pg.status });
  if (pg.currency_id !== "BRL" || Number(pg.transaction_amount) < PRECO) {
    console.error("Valor diferente do esperado", pg.id, pg.transaction_amount, pg.currency_id);
    return resposta({ ok: true, ignorado: true });
  }
  const compraId = String(pg.external_reference ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(compraId)) return resposta({ ok: true, ignorado: true });

  const { data: linhas, error } = await db.rpc("registrar_pagamento", {
    p_compra: compraId,
    p_pagamento: String(pg.id),
  });
  if (error) throw error;
  const fam = linhas?.[0];
  if (!fam) return resposta({ ok: true, repetido: true }); // já tinha sido registrado

  const ate = dataBR(fam.acesso_ate);
  const paraMae = fam.nova
    ? `Olá! Aqui é a Profª Ana Clara. Recebi seu pagamento, obrigada! O acesso vale até ${ate}. ` +
      `Abra ${PORTAL_URL} SÓ no aparelho que a criança usa para estudar, digite o e-mail e o WhatsApp da compra ` +
      `e toque em "Pedir código". Eu te mando o código por aqui. Cada família pode liberar até 2 aparelhos.`
    : `Olá! Aqui é a Profª Ana Clara. Recebi a renovação, obrigada! O acesso vale até ${ate}. ` +
      `Os aparelhos que já estavam liberados continuam funcionando.`;
  await avisarProfessora(
    `💰 ${fam.nova ? "Venda nova" : "Renovação"} – ${fam.familia_nome} – R$ ${pg.transaction_amount} (${pg.payment_type_id})\n` +
      `Acesso até: ${ate}\n` +
      `E-mail: ${fam.email}\n` +
      `WhatsApp da mãe: ${fam.whatsapp ? "+" + fam.whatsapp : "-"}\n\n` +
      `Já está cadastrada. Toque para mandar as boas-vindas:\n${linkWhats(fam.whatsapp, paraMae)}`,
  );

  return resposta({ ok: true });
}

// ---------- 4. Lembretes de vencimento (chamado todo dia pelo agendador) ----------
// Manda UMA mensagem para a professora com quem vence em 3 dias e quem venceu ontem,
// cada uma com um link que abre a conversa com a mãe já com o texto pronto.
// deno-lint-ignore no-explicit-any
async function lembretes(corpo: any) {
  // A chave fica na tabela configuracao; o agendador do banco manda a mesma chave
  const { data: cfg } = await db.from("configuracao").select("valor").eq("chave", "lembrete_chave").maybeSingle();
  const chave = cfg?.valor;
  if (!chave || chave.length < 12 || corpo.chave !== chave) return erro("Chave incorreta.", 401);

  const hoje = hojeEmBrasilia();
  const emTres = hojeEmBrasilia(3);
  const ontem = hojeEmBrasilia(-1);

  const { data: familias } = await db
    .from("familias")
    .select("id, nome, email, whatsapp, acesso_ate, lembrete_em")
    .eq("ativa", true)
    .in("acesso_ate", [emTres, ontem]);

  const pendentes = (familias ?? []).filter((f) => f.lembrete_em !== hoje);
  if (!pendentes.length) return resposta({ ok: true, enviados: 0 });

  const linhas = pendentes.map((f) => {
    const venceu = f.acesso_ate === ontem;
    const paraMae = `Olá! Aqui é a Profª Ana Clara. O acesso às atividades ${venceu ? "venceu" : "vence"} em ` +
      `${dataBR(f.acesso_ate)}. Para continuar, é só renovar com Pix ou cartão (R$ ${PRECO}) usando o mesmo e-mail: ${LOJA_URL}`;
    return `• ${f.nome} – ${venceu ? "VENCEU" : "vence"} ${dataBR(f.acesso_ate)}\n  ${linkWhats(f.whatsapp, paraMae)}`;
  });
  const ok = await avisarProfessora(`⏰ Mensalidades\n\n${linhas.join("\n\n")}`);
  if (ok) {
    await db.from("familias").update({ lembrete_em: hoje }).in("id", pendentes.map((f) => f.id));
  }
  const enviados = ok ? pendentes.length : 0;
  return resposta({ ok: true, enviados });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return erro("Método não permitido.", 405);

  try {
    if (new URL(req.url).searchParams.has("webhook")) return await webhook(req);

    // deno-lint-ignore no-explicit-any
    let corpo: any;
    try {
      corpo = await req.json();
    } catch {
      return erro("Pedido inválido.");
    }
    switch (corpo?.acao) {
      case "comprar": return await comprar(corpo, req);
      case "status": return await status(corpo);
      case "lembretes": return await lembretes(corpo);
      default: return erro("Ação desconhecida.");
    }
  } catch (e) {
    console.error(e);
    return erro("Erro no servidor. Tente de novo em instantes.", 500);
  }
});
