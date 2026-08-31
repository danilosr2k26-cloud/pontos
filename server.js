/* =========================================================================
   APP DE MATRÍCULAS — Backend (página + painel + API)
   -------------------------------------------------------------------------
   - Serve a página de acesso em "/" (busca a configuração da API)
   - Recebe as matrículas em /api/matriculas (upsert por sessão)
   - Painel em /painel: editar as configurações da página + ver matrículas
   Node.js + Express + Supabase (com reserva em arquivo para rodar local).
   ========================================================================= */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/* ---------- carrega .env (sem dependência) ---------- */
(function () {
  try {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    fs.readFileSync(p, "utf8").split(/\r?\n/).forEach((l) => {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    });
  } catch (e) {}
})();

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(16).toString("hex");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!ADMIN_PASSWORD) {
  console.error("\n[ERRO] Defina ADMIN_PASSWORD no .env antes de iniciar.\n");
  process.exit(1);
}

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  console.log("  Armazenamento: SUPABASE");
} else {
  console.log("  Armazenamento: arquivo local (temporário)");
}

const app = express();
app.use(express.json({ limit: "300kb" }));

/* =========================================================================
   Configuração padrão da página
   ========================================================================= */
const DEFAULT_CONFIG = {
  splash: { cor: "#0a3d62", logo: "", duracao: 3000 },
  acesso: {
    cor: "#0a3d62", imagem: "", digitos: 6,
    titulo: "Informe sua matrícula", corTitulo: "#ffffff",
    corBolinha: "#ffffff", corBolinhaPreenchida: "#000000",
    textoBotao: "Confirmar", corBotao: "#ffffff", corTextoBotao: "#0a3d62",
    textoDica: "Toque para digitar sua matrícula",
    corDica: "rgba(255,255,255,.75)", mostrarDica: true,
    pedirSegunda: true,
  },
  acesso2: {
    cor: "#0a3d62", imagem: "", digitos: 6,
    titulo: "Informe a segunda matrícula", corTitulo: "#ffffff",
    corBolinha: "#ffffff", corBolinhaPreenchida: "#000000",
    textoBotao: "Confirmar", corBotao: "#ffffff", corTextoBotao: "#0a3d62",
    textoDica: "Toque para digitar sua matrícula",
    corDica: "rgba(255,255,255,.75)", mostrarDica: true,
  },
  telaGif: {
    cor: "#0a3d62", imagem: "", titulo: "Aguarde um instante",
    texto: "Estamos preparando a próxima etapa.", gif: "",
    corTitulo: "#ffffff", corTexto: "rgba(255,255,255,.9)", duracao: 5000,
  },
  telaFinal: {
    cor: "#0a3d62", imagem: "", titulo: "Tudo certo!",
    texto: "Suas matrículas foram registradas.", gif: "",
    corTitulo: "#ffffff", corTexto: "rgba(255,255,255,.9)",
  },
};
function mesclarConfig(salvo) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (salvo && typeof salvo === "object") {
    for (const secao in out) {
      if (salvo[secao] && typeof salvo[secao] === "object") Object.assign(out[secao], salvo[secao]);
    }
  }
  return out;
}

/* =========================================================================
   Armazenamento (Supabase + reserva em arquivo)
   ========================================================================= */
const PASTA = path.join(__dirname, "data");
try { fs.mkdirSync(PASTA, { recursive: true }); } catch (e) {}
const ARQ_MAT = path.join(PASTA, "matriculas.json");
const ARQ_CFG = path.join(PASTA, "config.json");
const lerArq = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const salvarArq = (f, d) => { fs.mkdirSync(PASTA, { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); };

// ---- configuração ----
async function getConfig() {
  if (supabase) {
    const { data } = await supabase.from("config_pagina").select("dados").eq("id", "padrao").maybeSingle();
    return mesclarConfig(data ? data.dados : null);
  }
  return mesclarConfig(lerArq(ARQ_CFG));
}
async function saveConfig(dados) {
  const limpo = mesclarConfig(dados);
  if (supabase) {
    const { error } = await supabase.from("config_pagina").upsert({ id: "padrao", dados: limpo, atualizado_em: new Date().toISOString() });
    if (error) throw new Error(error.message);
  } else {
    salvarArq(ARQ_CFG, limpo);
  }
  return limpo;
}

// ---- matrículas (upsert por id de sessão) ----
function mapMat(r) {
  return { id: r.id, matricula1: r.matricula1 || "", matricula2: r.matricula2 || "", concluido: !!r.concluido, criadoEm: r.criado_em, concluidoEm: r.concluido_em, ip: r.ip || "", aparelho: r.aparelho || "", userAgent: r.user_agent || "" };
}

// monta uma descrição amigável do aparelho a partir do User-Agent + modelo (client hints)
function parseAparelho(ua, modeloCH) {
  ua = ua || "";
  let os = "", m;
  if (m = ua.match(/(iPhone|iPad|iPod)[^;]*OS ([\d_]+)/)) os = "iOS " + m[2].replace(/_/g, ".");
  else if (m = ua.match(/Android ?([\d.]+)?/)) os = "Android" + (m[1] ? " " + m[1] : "");
  else if (/Windows NT 10/.test(ua)) os = "Windows 10/11";
  else if (m = ua.match(/Windows NT ([\d.]+)/)) os = "Windows " + m[1];
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";

  let modelo = (modeloCH || "").trim();
  if (!modelo || modelo === "K") {          // "K" = Chrome esconde o modelo no UA
    if (/iPhone/.test(ua)) modelo = "iPhone";
    else if (/iPad/.test(ua)) modelo = "iPad";
    else if (m = ua.match(/Android[^;]*;\s*([^;)]+?)\s+Build\//)) modelo = m[1].trim();
    else if (m = ua.match(/Android[^;]*;\s*([^;)]+?)\)/)) modelo = m[1].trim();
    if (modelo === "K" || modelo === "wv") modelo = "";
  }
  let nav = "";
  if (/EdgA?\//.test(ua)) nav = "Edge";
  else if (/SamsungBrowser/.test(ua)) nav = "Samsung Internet";
  else if (/OPR\/|Opera/.test(ua)) nav = "Opera";
  else if (/Firefox\//.test(ua)) nav = "Firefox";
  else if (/Chrome\//.test(ua)) nav = "Chrome";
  else if (/Safari\//.test(ua)) nav = "Safari";

  return [modelo, os, nav].filter(Boolean).join(" · ") || (ua ? ua.slice(0, 60) : "");
}
async function salvarMatricula(id, campos) {
  if (supabase) {
    const { data, error } = await supabase.from("matriculas").update(campos).eq("id", id).select();
    if (error) throw new Error(error.message);
    if (!data || !data.length) {
      const { error: e2 } = await supabase.from("matriculas").insert(Object.assign({ id, criado_em: new Date().toISOString() }, campos));
      if (e2) throw new Error(e2.message);
    }
  } else {
    let lista = lerArq(ARQ_MAT) || [];
    const i = lista.findIndex((x) => x.id === id);
    if (i >= 0) lista[i] = Object.assign(lista[i], campos);
    else lista.unshift(Object.assign({ id, criado_em: new Date().toISOString() }, campos));
    salvarArq(ARQ_MAT, lista);
  }
}
async function listarMatriculas() {
  if (supabase) {
    const { data, error } = await supabase.from("matriculas").select("*").order("criado_em", { ascending: false }).limit(5000);
    if (error) throw new Error(error.message);
    return (data || []).map(mapMat);
  }
  return (lerArq(ARQ_MAT) || []).map(mapMat);
}

/* =========================================================================
   Autenticação (token assinado)
   ========================================================================= */
function assinar(p) {
  const c = Buffer.from(JSON.stringify(p)).toString("base64url");
  return c + "." + crypto.createHmac("sha256", AUTH_SECRET).update(c).digest("base64url");
}
function verificar(t) {
  if (!t || t.indexOf(".") < 0) return null;
  const [c, s] = t.split(".");
  const esp = crypto.createHmac("sha256", AUTH_SECRET).update(c).digest("base64url");
  try { if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(esp))) return null; } catch (e) { return null; }
  try { const d = JSON.parse(Buffer.from(c, "base64url").toString()); if (d.exp && Date.now() > d.exp) return null; return d; } catch (e) { return null; }
}
function exigirLogin(req, res, next) {
  const h = req.headers.authorization || "";
  const d = verificar(h.startsWith("Bearer ") ? h.slice(7) : "");
  if (!d) return res.status(401).json({ ok: false, erro: "Não autorizado" });
  next();
}

/* =========================================================================
   ROTAS
   ========================================================================= */
// config pública (a página consome)
app.get("/api/config", async (req, res) => {
  try { res.json({ ok: true, config: await getConfig() }); }
  catch (e) { console.error(e); res.json({ ok: true, config: DEFAULT_CONFIG }); }
});

// recebe matrícula (pública)
app.post("/api/matriculas", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ ok: false, erro: "Sem id" });
    const ip = (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (b.matricula2 !== undefined) {
      await salvarMatricula(b.id, { matricula2: String(b.matricula2), concluido: true, concluido_em: new Date().toISOString() });
    } else {
      const ua = String(b.ua || req.headers["user-agent"] || "");
      const campos = { matricula1: String(b.matricula1 || ""), concluido: !!b.concluir, ip,
        user_agent: ua, aparelho: parseAparelho(ua, b.modelo) };
      if (b.concluir) campos.concluido_em = new Date().toISOString();  // 1ª já finaliza (2ª desativada)
      await salvarMatricula(b.id, campos);
    }
    res.json({ ok: true });
  } catch (e) { console.error("Erro matrícula:", e); res.status(500).json({ ok: false, erro: "Erro ao salvar" }); }
});

// login
app.post("/api/login", (req, res) => {
  const { usuario, senha } = req.body || {};
  const okU = String(usuario || "") === ADMIN_USER;
  const okS = String(senha || "").length === ADMIN_PASSWORD.length &&
              crypto.timingSafeEqual(Buffer.from(String(senha)), Buffer.from(ADMIN_PASSWORD));
  if (!okU || !okS) return res.status(401).json({ ok: false, erro: "Usuário ou senha inválidos" });
  res.json({ ok: true, token: assinar({ u: ADMIN_USER, exp: Date.now() + 1000 * 60 * 60 * 12 }), usuario: ADMIN_USER });
});

// salvar config (admin)
app.put("/api/config", exigirLogin, async (req, res) => {
  try { res.json({ ok: true, config: await saveConfig(req.body || {}) }); }
  catch (e) { console.error(e); res.status(500).json({ ok: false, erro: "Erro ao salvar config" }); }
});

// listar matrículas (admin)
app.get("/api/matriculas", exigirLogin, async (req, res) => {
  try {
    const lista = await listarMatriculas();
    const hoje = new Date().toISOString().slice(0, 10);
    res.json({
      ok: true, total: lista.length,
      concluidas: lista.filter((m) => m.concluido).length,
      hoje: lista.filter((m) => (m.criadoEm || "").slice(0, 10) === hoje).length,
      matriculas: lista,
    });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, erro: "Erro" }); }
});

// exportar CSV (admin)
app.get("/api/export", exigirLogin, async (req, res) => {
  const lista = await listarMatriculas();
  const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const linhas = ["matricula1;matricula2;concluido;aparelho;criado_em;concluido_em"];
  lista.forEach((m) => linhas.push([m.matricula1, m.matricula2, m.concluido ? "sim" : "não", m.aparelho, m.criadoEm, m.concluidoEm].map(esc).join(";")));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="matriculas.csv"');
  res.send("﻿" + linhas.join("\r\n"));
});

/* estáticos + páginas */
app.use(express.static(path.join(__dirname, "site")));
app.get("/painel", (req, res) => res.sendFile(path.join(__dirname, "public", "painel.html")));
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "site", "index.html")));
app.use((err, req, res, next) => { console.error(err); if (!res.headersSent) res.status(500).json({ ok: false, erro: "Erro interno" }); });

app.listen(PORT, () => {
  console.log(`\n  Página:  http://localhost:${PORT}/`);
  console.log(`  Painel:  http://localhost:${PORT}/painel`);
  console.log(`  Usuário: ${ADMIN_USER}\n`);
});