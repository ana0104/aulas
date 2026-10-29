import { createClient } from "npm:@supabase/supabase-js@2";

const COM_CODIGO = true;                 // true = a professora recebe o código no WhatsApp e repassa à mãe
                                         // false = o aparelho entra direto, sem código (até o limite)
const DIAS_CRACHA = 90;                  // crachá vence após 90 dias SEM uso
const MAX_TENTATIVAS_HORA = 10;          // tentativas de entrar por internet (IP) em 1h
const MAX_TENTATIVAS_CODIGO = 5;         // erros de código antes de travar o pedido
const MAX_PEDIDOS_DIA = 5;               // pedidos de código por família em 24h
const WHATSAPP_PROFESSORA = "5511976280903"; // recebe os avisos (precisa do segredo CALLMEBOT_APIKEY)

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

function resposta(dados: unknown, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function erro(mensagem: string, status = 400, motivo?: string) {
  return resposta({ erro: mensagem, motivo }, status);
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(texto: string) {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return hex(new Uint8Array(dig));
}

function novoToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function ipDe(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
}

function navegadorDe(req: Request) {
  return (req.headers.get("user-agent") ?? "").slice(0, 200) || null;
}

function novoCodigo() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return n.toString().padStart(6, "0");
}

function daquiDias(dias: number) {
  return new Date(Date.now() + dias * 86400000).toISOString();
}

// "(11) 97628-0903" vira "5511976280903". Devolve "" se não parecer um celular.
function soNumeros(telefone: string) {
  let n = String(telefone ?? "").replace(/\D/g, "");
  if (n.length === 10 || n.length === 11) n = "55" + n;
  return /^55\d{10,11}$/.test(n) ? n : "";
}

// Manda uma mensagem no WhatsApp da professora pelo CallMeBot.
// Se o segredo não existir ou o envio falhar, o resto continua funcionando.
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

function linkWhats(numero: string | null, texto: string) {
  return numero ? `https://wa.me/${numero}?text=${encodeURIComponent(texto)}` : "(sem WhatsApp)";
}

// Devolve um erro se a família não puder entrar agora, ou null se estiver tudo certo.
// deno-lint-ignore no-explicit-any
function bloqueioDaFamilia(f: any): Response | null {
  if (!f || !f.ativa) {
    return erro("O acesso da família está pausado. Fale com a professora.", 403, "pausada");
  }
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // AAAA-MM-DD
  if (f.acesso_ate && f.acesso_ate < hoje) {
    return erro("A mensalidade venceu. Toque em Renovar para continuar usando.", 403, "assinatura");
  }
  return null;
}

async function aparelhosAtivos(familiaId: string) {
  const { count } = await db
    .from("aparelhos")
    .select("id", { count: "exact", head: true })
    .eq("familia_id", familiaId)
    .eq("ativo", true)
    .gt("expira_em", new Date().toISOString());
  return count ?? 0;
}

const MSG_LIMITE = (limite: number) =>
  `Esta família já tem ${limite} aparelho(s) liberado(s), que é o limite. ` +
  `Para trocar de aparelho ou colocar mais um, fale com a professora.`;

// Confere o crachá do aparelho. Devolve a família ou uma resposta de erro.
// deno-lint-ignore no-explicit-any
async function conferirCracha(token: unknown, req: Request): Promise<{ familia?: any; falha?: Response }> {
  if (typeof token !== "string" || token.length !== 64) {
    return { falha: erro("Este aparelho ainda não foi liberado.", 401, "aparelho") };
  }
  const { data: ap } = await db
    .from("aparelhos")
    .select("id, ativo, expira_em, familia:familias(id, nome, ativa, acesso_ate)")
    .eq("token_hash", await sha256(token))
    .maybeSingle();

  if (!ap || !ap.ativo || new Date(ap.expira_em) < new Date()) {
    return { falha: erro("Este aparelho precisa ser liberado de novo.", 401, "aparelho") };
  }
  const bloqueio = bloqueioDaFamilia(ap.familia);
  if (bloqueio) return { falha: bloqueio };

  await db.from("aparelhos").update({
    ultimo_acesso: new Date().toISOString(),
    expira_em: daquiDias(DIAS_CRACHA),
    ip: ipDe(req),
  }).eq("id", ap.id);

  return { familia: ap.familia };
}

// ---------- A mãe pede para liberar o aparelho de estudos (só se ainda tiver vaga) ----------
// deno-lint-ignore no-explicit-any
async function entrar(corpo: any, req: Request) {
  const email = String(corpo.email ?? "").trim().toLowerCase();
  const whatsapp = soNumeros(corpo.whatsapp);
  const apelido = String(corpo.apelido ?? "").trim().slice(0, 60) || "Aparelho sem nome";
  if (!email.includes("@")) return erro("Digite o e-mail usado na compra.");
  if (!whatsapp) return erro("Digite o WhatsApp usado na compra, com DDD.");
  if (corpo.confirmo !== true) return erro("Confirme que este é o aparelho de estudos da criança.");

  const ip = ipDe(req);
  if (ip) {
    const { count } = await db
      .from("tentativas_entrada")
      .select("id", { count: "exact", head: true })
      .eq("ip", ip)
      .eq("ok", false)
      .gte("criado_em", new Date(Date.now() - 3600000).toISOString());
    if ((count ?? 0) >= MAX_TENTATIVAS_HORA) return erro("Muitas tentativas. Espere uma hora ou fale com a professora.");
  }

  const { data: familia } = await db
    .from("familias")
    .select("id, nome, email, whatsapp, ativa, acesso_ate, limite_aparelhos")
    .eq("email", email)
    .maybeSingle();

  // O WhatsApp precisa bater com o da compra (comparando os 8 últimos números)
  const confere = familia && (!familia.whatsapp || familia.whatsapp.slice(-8) === whatsapp.slice(-8));
  await db.from("tentativas_entrada").insert({ ip, email, ok: !!confere });
  if (!confere) {
    return erro("Não encontramos esse e-mail com esse WhatsApp. Confira se são os mesmos usados na compra.");
  }

  const bloqueio = bloqueioDaFamilia(familia);
  if (bloqueio) return bloqueio;

  if (!familia.whatsapp) await db.from("familias").update({ whatsapp }).eq("id", familia.id);
  const whatsMae = familia.whatsapp ?? whatsapp;

  // Sem vaga, nem gera código: trocar ou colocar mais aparelhos só com a professora
  const usados = await aparelhosAtivos(familia.id);
  if (usados >= familia.limite_aparelhos) return erro(MSG_LIMITE(familia.limite_aparelhos), 400, "limite");

  if (!COM_CODIGO) {
    const token = await liberar(familia, apelido, req);
    if (typeof token !== "string") return token;
    await avisarProfessora(
      `📱 Aparelho novo – ${familia.nome}\n` +
        `Aparelho: ${apelido} (${usados + 1} de ${familia.limite_aparelhos})\n` +
        `E-mail: ${familia.email}\n` +
        `WhatsApp da mãe: ${linkWhats(whatsMae, "Olá! Aqui é a Profª Ana Clara.")}`,
    );
    return resposta({ token, familia: familia.nome });
  }

  const { count } = await db
    .from("pedidos_codigo")
    .select("id", { count: "exact", head: true })
    .eq("familia_id", familia.id)
    .gte("criado_em", new Date(Date.now() - 86400000).toISOString());
  if ((count ?? 0) >= MAX_PEDIDOS_DIA) return erro("Muitos pedidos hoje. Fale com a professora.");

  const codigo = novoCodigo();
  const { data: pedido, error } = await db
    .from("pedidos_codigo")
    .insert({
      familia_id: familia.id,
      familia_nome: familia.nome,
      email: familia.email,
      whatsapp: whatsMae,
      apelido,
      codigo,
      ip,
      navegador: navegadorDe(req),
    })
    .select("id")
    .single();
  if (error) throw error;

  const paraMae = `Olá! Aqui é a Profª Ana Clara. O código para liberar o aparelho "${apelido}" é ${codigo}. ` +
    `Digite na tela do portal. Ele vale por 24 horas.`;
  await avisarProfessora(
    `🔑 Código ${codigo} – ${familia.nome}\n` +
      `Aparelho: ${apelido} (vaga ${usados + 1} de ${familia.limite_aparelhos})\n` +
      `E-mail: ${familia.email}\n` +
      `WhatsApp da mãe: +${whatsMae}\n\n` +
      `Toque para mandar o código para ela:\n${linkWhats(whatsMae, paraMae)}`,
  );

  return resposta({ pedido_id: pedido.id });
}

// deno-lint-ignore no-explicit-any
async function confirmarCodigo(corpo: any, req: Request) {
  const pedidoId = String(corpo.pedido_id ?? "");
  const codigo = String(corpo.codigo ?? "").replace(/\D/g, "");

  const { data: pedido } = await db
    .from("pedidos_codigo")
    .select("*")
    .eq("id", pedidoId)
    .maybeSingle();

  if (!pedido) return erro("Pedido não encontrado. Peça um novo código.", 400, "pedido");
  if (pedido.usado) return erro("Esse código já foi usado. Peça um novo.", 400, "pedido");
  if (new Date(pedido.expira_em) < new Date()) return erro("O código venceu. Peça um novo.", 400, "pedido");
  if (pedido.tentativas >= MAX_TENTATIVAS_CODIGO) return erro("Muitas tentativas erradas. Peça um novo código.", 400, "pedido");

  if (codigo !== pedido.codigo) {
    await db.from("pedidos_codigo").update({ tentativas: pedido.tentativas + 1 }).eq("id", pedido.id);
    const restam = MAX_TENTATIVAS_CODIGO - pedido.tentativas - 1;
    return erro(restam > 0 ? `Código incorreto. Restam ${restam} tentativa(s).` : "Muitas tentativas erradas. Peça um novo código.");
  }

  // Marca como usado (só funciona uma vez, mesmo com dois cliques rápidos)
  const { data: marcado } = await db
    .from("pedidos_codigo")
    .update({ usado: true })
    .eq("id", pedido.id)
    .eq("usado", false)
    .select("id");
  if (!marcado || marcado.length === 0) return erro("Esse código já foi usado. Peça um novo.", 400, "pedido");

  const { data: familia } = await db
    .from("familias")
    .select("id, nome, ativa, acesso_ate, limite_aparelhos")
    .eq("id", pedido.familia_id)
    .single();
  const bloqueio = bloqueioDaFamilia(familia);
  if (bloqueio) return bloqueio;

  const token = await liberar(familia, pedido.apelido, req);
  if (typeof token !== "string") return token;
  return resposta({ token, familia: familia.nome });
}

// Só entra se ainda tiver vaga. Nenhum aparelho antigo é desligado sozinho.
// deno-lint-ignore no-explicit-any
async function liberar(familia: any, apelido: string, req: Request): Promise<string | Response> {
  const token = novoToken();
  const { data: situacao, error } = await db.rpc("liberar_aparelho", {
    p_familia: familia.id,
    p_apelido: apelido,
    p_token_hash: await sha256(token),
    p_ip: ipDe(req),
    p_navegador: navegadorDe(req),
    p_expira: daquiDias(DIAS_CRACHA),
  });
  if (error) throw error;
  if (situacao === "limite") return erro(MSG_LIMITE(familia.limite_aparelhos), 400, "limite");
  if (situacao !== "ok") return erro("Não consegui liberar este aparelho. Fale com a professora.");
  return token;
}

// deno-lint-ignore no-explicit-any
async function listar(corpo: any, req: Request) {
  const { familia, falha } = await conferirCracha(corpo.token, req);
  if (falha) return falha;

  const { data: sites } = await db
    .from("sites")
    .select("slug, titulo")
    .eq("publicado", true)
    .order("ordem", { ascending: true })
    .order("criado_em", { ascending: false });

  return resposta({ familia: familia.nome, acesso_ate: familia.acesso_ate, sites: sites ?? [] });
}

// deno-lint-ignore no-explicit-any
async function abrir(corpo: any, req: Request) {
  const { familia, falha } = await conferirCracha(corpo.token, req);
  if (falha) return falha;

  const { data: site } = await db
    .from("sites")
    .select("titulo, arquivo")
    .eq("slug", String(corpo.slug ?? ""))
    .eq("publicado", true)
    .maybeSingle();
  if (!site) return erro("Site não encontrado.", 404);

  const { data: arquivo, error } = await db.storage.from("sites").download(site.arquivo);
  if (error || !arquivo) return erro("Não consegui abrir o arquivo do site. Avise a professora.", 500);

  return resposta({ familia: familia.nome, titulo: site.titulo, html: await arquivo.text() });
}

// ---------- Painel da professora (precisa do segredo PAINEL_SENHA) ----------

// deno-lint-ignore no-explicit-any
async function senhaDoPainelConfere(corpo: any) {
  const certa = Deno.env.get("PAINEL_SENHA");
  if (!certa || certa.length < 8) return false;
  const ok = await sha256(String(corpo.senha ?? "")) === await sha256(certa);
  if (!ok) await new Promise((r) => setTimeout(r, 1500)); // atrasa quem tenta adivinhar
  return ok;
}

async function painelResumo() {
  const agora = new Date().toISOString();
  const [{ data: familias }, { data: aparelhos }, { data: sites }, { data: pedidos }] = await Promise.all([
    db.from("familias")
      .select("id, nome, email, whatsapp, ativa, acesso_ate, limite_aparelhos")
      .order("nome", { ascending: true }),
    db.from("aparelhos")
      .select("id, familia_id, apelido, criado_em, ultimo_acesso")
      .eq("ativo", true)
      .gt("expira_em", agora)
      .order("criado_em", { ascending: true }),
    db.from("sites")
      .select("slug, titulo, publicado, ordem, criado_em")
      .order("ordem", { ascending: true })
      .order("criado_em", { ascending: false }),
    db.from("pedidos_codigo")
      .select("familia_nome, email, whatsapp, apelido, codigo, criado_em")
      .eq("usado", false)
      .gt("expira_em", agora)
      .lt("tentativas", MAX_TENTATIVAS_CODIGO)
      .order("criado_em", { ascending: false })
      .limit(30),
  ]);
  return resposta({
    familias: (familias ?? []).map((f) => ({
      ...f,
      aparelhos: (aparelhos ?? []).filter((a) => a.familia_id === f.id),
    })),
    sites: sites ?? [],
    pedidos: pedidos ?? [],
  });
}

// Transforma "Revisão de Português!" em "revisao-de-portugues"
function semAcento(texto: string) {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// deno-lint-ignore no-explicit-any
async function painel(corpo: any) {
  if (!await senhaDoPainelConfere(corpo)) return erro("Senha incorreta.", 401, "senha");

  switch (corpo.acao) {
    case "painel_resumo":
      return await painelResumo();

    case "painel_tirar_aparelho": {
      const { error } = await db.from("aparelhos").update({ ativo: false }).eq("id", String(corpo.id ?? ""));
      if (error) throw error;
      return await painelResumo();
    }

    case "painel_familia": {
      const mudar: Record<string, unknown> = {};
      if (typeof corpo.ativa === "boolean") mudar.ativa = corpo.ativa;
      if (Number.isInteger(corpo.limite_aparelhos) && corpo.limite_aparelhos >= 1 && corpo.limite_aparelhos <= 6) {
        mudar.limite_aparelhos = corpo.limite_aparelhos;
      }
      if (!Object.keys(mudar).length) return erro("Nada para mudar.");
      const { error } = await db.from("familias").update(mudar).eq("id", String(corpo.id ?? ""));
      if (error) throw error;
      return await painelResumo();
    }

    case "painel_cadastrar": {
      const nome = String(corpo.nome ?? "").trim().slice(0, 80);
      const email = String(corpo.email ?? "").trim().toLowerCase();
      const whatsapp = soNumeros(corpo.whatsapp);
      const ate = String(corpo.acesso_ate ?? "").trim();
      if (!nome || !email.includes("@")) return erro("Preencha nome e e-mail.");
      if (corpo.whatsapp && !whatsapp) return erro("Confira o WhatsApp (com DDD).");
      if (ate && !/^\d{4}-\d{2}-\d{2}$/.test(ate)) return erro("Data inválida.");
      const { error } = await db.from("familias").insert({ nome, email, whatsapp: whatsapp || null, acesso_ate: ate || null });
      if (error?.code === "23505") return erro("Esse e-mail já está cadastrado.");
      if (error) throw error;
      return await painelResumo();
    }

    case "painel_enviar_site": {
      const titulo = String(corpo.titulo ?? "").trim().slice(0, 120);
      const html = String(corpo.html ?? "");
      const slug = semAcento(String(corpo.slug || titulo));
      if (!titulo || !slug) return erro("Escreva o título da atividade.");
      if (html.length < 20 || !/<html|<body|<div|<!doctype/i.test(html)) return erro("Escolha um arquivo .html.");
      if (html.length > 8 * 1024 * 1024) return erro("Arquivo grande demais (máximo 8 MB).");

      // Mesmo título = substitui a atividade (serve para corrigir um site que já está no ar)
      const arquivo = slug + ".html";
      const { error: errArq } = await db.storage.from("sites").upload(
        arquivo,
        new Blob([html], { type: "text/html; charset=utf-8" }),
        { upsert: true, contentType: "text/html; charset=utf-8" },
      );
      if (errArq) throw errArq;

      const { error } = await db.from("sites").upsert(
        { slug, titulo, arquivo, publicado: true },
        { onConflict: "slug" },
      );
      if (error) throw error;
      return await painelResumo();
    }

    case "painel_site": {
      const slug = String(corpo.slug ?? "");
      if (corpo.apagar === true) {
        const { data: site } = await db.from("sites").select("arquivo").eq("slug", slug).maybeSingle();
        await db.from("sites").delete().eq("slug", slug);
        if (site) await db.storage.from("sites").remove([site.arquivo]);
        return await painelResumo();
      }
      const mudar: Record<string, unknown> = {};
      if (typeof corpo.publicado === "boolean") mudar.publicado = corpo.publicado;
      if (Number.isInteger(corpo.ordem)) mudar.ordem = corpo.ordem;
      if (!Object.keys(mudar).length) return erro("Nada para mudar.");
      const { error } = await db.from("sites").update(mudar).eq("slug", slug);
      if (error) throw error;
      return await painelResumo();
    }

    case "painel_testar_whatsapp": {
      const ok = await avisarProfessora("✅ Teste do painel: os avisos estão chegando no seu WhatsApp.");
      if (!ok) return erro("Não consegui mandar. Confira o segredo CALLMEBOT_APIKEY.");
      return await painelResumo();
    }

    default:
      return erro("Ação desconhecida.");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return erro("Método não permitido.", 405);

  // deno-lint-ignore no-explicit-any
  let corpo: any;
  try {
    corpo = await req.json();
  } catch {
    return erro("Pedido inválido.");
  }

  try {
    if (String(corpo?.acao ?? "").startsWith("painel_")) return await painel(corpo);
    switch (corpo?.acao) {
      case "entrar": return await entrar(corpo, req);
      case "confirmar_codigo": return await confirmarCodigo(corpo, req);
      case "listar": return await listar(corpo, req);
      case "abrir": return await abrir(corpo, req);
      default: return erro("Ação desconhecida.");
    }
  } catch (e) {
    console.error(e);
    return erro("Erro no servidor. Tente de novo em instantes.", 500);
  }
});
