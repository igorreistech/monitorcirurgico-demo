// Shim que imita a fatia da API do Firestore/Storage SDK usada por app.js,
// index.html e fichas-opme.html, implementada por cima do supabase-js.
// Objetivo: trocar Firebase por Supabase sem reescrever as ~80 call-sites
// espalhadas pelo app — só a inicialização muda.
//
// Limitações conhecidas (aceitáveis para o app atual, ver plano de migração):
// - onSnapshot entrega sempre a coleção inteira a cada mudança (não deltas),
//   replicando o comportamento do Firestore que o código consumidor espera.
// - query/orderBy só suportam o uso real do app (orderBy simples), não é
//   um query builder genérico.

// ───────────────────────── Mapeamento de campos ─────────────────────────
// Firestore usava camelCase; o schema Postgres usa snake_case. Os mapas
// abaixo convertem nos dois sentidos, tabela por tabela.

const FIELD_MAPS = {
  procedimentos: {
    pacienteIdade: 'paciente_idade',
    tipoCirurgia: 'tipo_cirurgia',
    nfData: 'nf_data',
    nfCompra: 'nf_compra',
    dataRetirar: 'data_retirar',
    horaRetirar: 'hora_retirar',
    coletaDataCirurgia: 'coleta_data_cirurgia',
    coletaHoraCirurgia: 'coleta_hora_cirurgia',
    coletaFornecedor: 'coleta_fornecedor',
    coletaTransportadora: 'coleta_transportadora',
    coletaObs: 'coleta_obs',
    coletaAnexo: 'coleta_anexo',
    coletaChaveAcesso: 'coleta_chave_acesso',
    coletaCirurgiaId: 'coleta_cirurgia_id',
    _filial: 'filial',
    isColeta: 'is_coleta',
    cadastradoPor: 'cadastrado_por',
    _statusHistory: 'status_history',
    autoTransicaoEm: 'auto_transicao_em',
    retiradaConfirmada: 'retirada_confirmada',
    dataConfirmacaoRetirada: 'data_confirmacao_retirada',
    motivoReagendamento: 'motivo_reagendamento',
    operadorNome: 'operador_nome',
  },
  fichas_opme: {
    numeroPedido: 'numero_pedido',
    dataCirurgia: 'data_cirurgia',
    opmeAnexoUrl: 'opme_anexo_url',
    opmeAnexoNome: 'opme_anexo_nome',
    pvAnexoUrl: 'pv_anexo_url',
    pvAnexoNome: 'pv_anexo_nome',
    criadoPor: 'criado_por',
    criadoEm: 'criado_em',
    atualizadoEm: 'atualizado_em',
    _statusHistory: 'status_history',
  },
  usuarios: {
    firebaseUid: 'firebase_uid',
    criadoEm: 'criado_em',
  },
};

// status de fichas_opme: Firestore guardava inteiro 0-5, Postgres usa enum string.
const FICHA_STATUS_POR_INDICE = [
  'pendente', 'pedido_criado', 'em_laudacao', 'autorizado', 'aguardando_faturamento', 'faturado',
];

function camelToSnakeRow(table, obj) {
  const map = FIELD_MAPS[table] || {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_docId' || k === 'id') continue; // id é tratado à parte
    // Qualquer campo com "_" que não esteja no FIELD_MAPS é metadado só de
    // memória — nunca é coluna real da tabela (evita 400 do PostgREST).
    if (k.startsWith('_') && !map[k]) continue;
    const col = map[k] || k;
    out[col] = v;
  }
  if (table === 'fichas_opme' && typeof out.status === 'number') {
    out.status = FICHA_STATUS_POR_INDICE[out.status] || 'pendente';
  }
  return out;
}

function snakeToCamelRow(table, row) {
  const map = FIELD_MAPS[table] || {};
  const reverse = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id') continue;
    const camel = reverse[k] || k;
    out[camel] = v;
  }
  if (table === 'fichas_opme' && typeof out.status === 'string') {
    const idx = FICHA_STATUS_POR_INDICE.indexOf(out.status);
    out.status = idx >= 0 ? idx : 0;
  }
  return out;
}

// ───────────────────────── Firestore-like API ─────────────────────────

export function createFirestoreShim(supabase) {
  function collection(_db, table) {
    return { _table: table };
  }

  function doc(_db, table, id) {
    if (typeof table === 'object' && table._table) { id = id; table = table._table; }
    return { _table: table, _id: id };
  }

  function query(collRef, ...clauses) {
    return { _table: collRef._table, _clauses: clauses };
  }

  function orderBy(field, direction = 'asc') {
    return { _type: 'orderBy', field, direction };
  }

  async function addDoc(collRef, data) {
    const row = camelToSnakeRow(collRef._table, data);
    const { data: inserted, error } = await supabase.from(collRef._table).insert(row).select().single();
    if (error) throw error;
    return { id: inserted.id };
  }

  async function setDoc(docRef, data, opts) {
    const row = camelToSnakeRow(docRef._table, data);
    if (opts?.merge) {
      const { error } = await supabase.from(docRef._table).update(row).eq('id', docRef._id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from(docRef._table).upsert({ id: docRef._id, ...row });
      if (error) throw error;
    }
  }

  async function getDoc(docRef) {
    const { data, error } = await supabase.from(docRef._table).select('*').eq('id', docRef._id).maybeSingle();
    if (error) throw error;
    return {
      id: docRef._id,
      exists: () => !!data,
      data: () => data ? snakeToCamelRow(docRef._table, data) : undefined,
    };
  }

  async function getDocs(collRefOrQuery) {
    let q = supabase.from(collRefOrQuery._table).select('*');
    for (const clause of collRefOrQuery._clauses || []) {
      if (clause._type === 'orderBy') {
        const map = FIELD_MAPS[collRefOrQuery._table] || {};
        const col = map[clause.field] || clause.field;
        q = q.order(col, { ascending: clause.direction !== 'desc' });
      }
    }
    const { data, error } = await q;
    if (error) throw error;
    const docs = data.map(row => ({
      id: row.id,
      data: () => snakeToCamelRow(collRefOrQuery._table, row),
    }));
    // forEach replica a API real do QuerySnapshot do Firestore (que tem
    // .docs E .forEach) — várias call-sites legadas usam snap.forEach direto.
    return { docs, empty: docs.length === 0, forEach: cb => docs.forEach(cb) };
  }

  async function deleteDoc(docRef) {
    const { error } = await supabase.from(docRef._table).delete().eq('id', docRef._id);
    if (error) throw error;
  }

  // Snapshot inicial via select() + assinatura de postgres_changes, mantendo
  // um cache local em memória e re-emitindo a coleção inteira a cada evento
  // — replica "callback recebe array completo a cada mudança", que é o que
  // todo o código consumidor (onSnapshot do app) espera.
  function onSnapshot(collRefOrQuery, callback) {
    const table = collRefOrQuery._table;
    let cache = new Map(); // id -> row (snake_case, como vem do Postgres)
    let pronto = false;
    let pendentes = []; // eventos chegados antes da carga inicial terminar

    function emit() {
      const docs = [...cache.values()].map(row => ({
        id: row.id,
        data: () => snakeToCamelRow(table, row),
      }));
      callback({ docs, empty: docs.length === 0, forEach: cb => docs.forEach(cb) });
    }

    function aplicar(payload) {
      if (payload.eventType === 'DELETE') {
        cache.delete(payload.old.id);
      } else {
        cache.set(payload.new.id, payload.new);
      }
    }

    // A assinatura do canal precisa ficar ativa ANTES do SELECT inicial rodar,
    // senão existe uma janela entre "SELECT terminou" e "canal inscrito" em que
    // uma mudança no servidor não é capturada por nenhum dos dois lados (não
    // está no snapshot, que já foi tirado, e não dispara evento, porque o canal
    // ainda não estava ouvindo) — ela só reapareceria se algum outro evento
    // qualquer disparasse um novo emit(), ou nunca, até recarregar a página.
    // Por isso: inscreve o canal primeiro; eventos que chegarem antes da carga
    // inicial terminar ficam em buffer e são reaplicados por cima do snapshot
    // assim que ele chega (reaplicar é idempotente — upsert/delete por id).
    const channel = supabase
      .channel(`shim-${table}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, payload => {
        if (!pronto) { pendentes.push(payload); return; }
        aplicar(payload);
        emit();
      })
      .subscribe(async status => {
        if (status !== 'SUBSCRIBED' || pronto) return;
        const { data, error } = await supabase.from(table).select('*');
        if (error) { console.error(`onSnapshot(${table}) carga inicial falhou:`, error); return; }
        cache = new Map(data.map(r => [r.id, r]));
        pendentes.forEach(aplicar);
        pendentes = [];
        pronto = true;
        emit();
      });

    // Firestore retorna uma função de unsubscribe — replicamos a mesma interface.
    return () => supabase.removeChannel(channel);
  }

  return { collection, doc, query, orderBy, addDoc, setDoc, getDoc, getDocs, deleteDoc, onSnapshot };
}

// ───────────────────────── Storage-like API ─────────────────────────
//
// Bucket privado: getDownloadURL gera uma signed URL de longa duração
// (10 anos) em vez de URL pública, para manter compatível com todo o
// código existente que trata o retorno como uma URL pronta pra usar em
// <img src>/<a href> sem precisar regenerar o link a cada visualização.
// Decisão pragmática para o piloto — endurecer depois (signed URL curta +
// regeneração sob demanda) é melhoria de segurança incremental, não bloqueia
// o corte de produção.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365 * 10;

export function createStorageShim(supabase, defaultBucket = 'opme') {
  function ref(_storage, path) {
    return { _path: path };
  }

  async function uploadBytes(storageRef, file) {
    const { error } = await supabase.storage.from(defaultBucket).upload(storageRef._path, file, { upsert: true });
    if (error) throw error;
    return { ref: storageRef };
  }

  async function getDownloadURL(storageRef) {
    const { data, error } = await supabase.storage
      .from(defaultBucket)
      .createSignedUrl(storageRef._path, SIGNED_URL_TTL_SECONDS);
    if (error) throw error;
    return data.signedUrl;
  }

  return { ref, uploadBytes, getDownloadURL };
}
