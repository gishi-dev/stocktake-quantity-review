export const categories = ['比較できる差', '反映時点のずれ', '条件不足', '調整済み', '材料不足'];
export const reference = '2026-10-18T17:00';

export function validateItem(item) {
  if (!item || !/^[A-Z][A-Z0-9-]{0,15}$/.test(item.id) ||
      !/^架空留め具[A-Z0-9-]+$/.test(item.name) || !Array.isArray(item.records) || item.records.length > 100) {
    throw Error('品目IDは英大文字・数字・ハイフン、名前は「架空留め具」に同じ文字を続けてください。記録は100行までです。');
  }
  const ids = new Set();
  for (const r of item.records) {
    if (!r || typeof r.id !== 'string' || !/^[LSTJU]-[A-Z0-9-]+$/.test(r.id) || ids.has(r.id) ||
        !['L', 'S', 'T', 'J', 'U'].includes(r.kind) || !r.id.startsWith(`${r.kind}-`) ||
        !Number.isFinite(r.quantity) || Math.abs(r.quantity) > 1000000 || (r.kind !== 'J' && r.quantity < 0) ||
        !['個', '箱'].includes(r.unit) || !['第一庫', '第二庫', '第一庫＋第二庫'].includes(r.scope) ||
        !/^2026-10-18T(?:[01]\d|2[0-3]):[0-5]\d$/.test(r.time)) {
      throw Error('元番号は種類L/S/T/J/Uと一致し重複なし、数量は有限の数、単位は個か箱、場所は第一庫・第二庫・第一庫＋第二庫、時刻は2026-10-18THH:MMにしてください。');
    }
    if (r.kind === 'T' && (!/^(IN|OUT)-[A-Z0-9-]+$/.test(r.voucher) ||
        !['入庫', '出庫'].includes(r.direction) || typeof r.reflected !== 'boolean')) {
      throw Error('入出庫には伝票番号IN-/OUT-、direction（入庫・出庫）、reflected（true・false）が必要です。');
    }
    if (r.kind === 'J' && typeof r.target !== 'string') throw Error('調整履歴には対象の棚卸表targetが必要です。');
    if (r.kind === 'U' && (r.unit !== '個' || r.quantity <= 0 || typeof r.unopened !== 'boolean')) throw Error('入り数は正の個数とunopened（true・false）が必要です。');
    if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 1000)) throw Error('記録の注記は1000文字までです。');
    ids.add(r.id);
  }
  if (item.records.filter(r => r.kind === 'U').length > 1) throw Error('入り数の記録は品目につき1行です。');
}

// 本文やAIの候補は計算に使わない。数量、場所、時点、伝票番号だけを扱う。
export function calculate(item, method) {
  const records = item.records;
  const steps = [];
  const issues = [];
  const pack = records.find(r => r.kind === 'U');
  const units = r => {
    if (r.unit === '個') return r.quantity;
    if (!pack?.unopened) {
      issues.push(`${r.id}：未開封の入り数が未確認`);
      return null;
    }
    steps.push(`${r.id}：${r.quantity}箱 × ${pack.quantity}個（${pack.id}） = ${r.quantity * pack.quantity}個`);
    return r.quantity * pack.quantity;
  };
  const ledgers = records.filter(r => r.kind === 'L').sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  const ledger = ledgers.at(-1);
  const counts = records.filter(r => r.kind === 'S');
  const adjustments = records.filter(r => r.kind === 'J' && counts.some(s => s.id === r.target));
  if (!ledger || !counts.length) return { difference: null, ledger: null, counted: null, oldDifference: null, steps, conditions: '条件不足：帳簿または棚卸表がありません', explanation: '計算の材料が不足', provisional: true, adjustments };
  let book = units(ledger);
  let count = 0;
  const scopes = counts.flatMap(s => s.scope.split('＋'));
  if (new Set(scopes).size !== scopes.length) issues.push('棚卸表の保管場所が重複');
  const scope = [...new Set(scopes)].sort().join('＋');
  const ledgerScope = ledger.scope.split('＋').sort().join('＋');
  if (scope !== ledgerScope) issues.push('保管場所の範囲が不一致');
  for (const s of counts) {
    const quantity = units(s);
    count = count === null || quantity === null ? null : count + quantity;
    if (s.time !== reference) issues.push(`${s.id}：棚卸表が基準時点ではない`);
  }
  // 同じ番号でも内容が異なる場合は、同一取引と決めず暫定扱いにする。
  const seen = new Map();
  let used = 0;
  for (const t of records.filter(r => r.kind === 'T')) {
    const signature = JSON.stringify([t.quantity, t.unit, t.time, t.direction, t.reflected, t.scope]);
    if (method === 'unique' && seen.has(t.voucher)) {
      if (seen.get(t.voucher) !== signature) issues.push(`${t.voucher}：同番号の内容が不一致`);
      steps.push(`${t.id}：${t.voucher}を再掲として除外（内容の一致は人が確認）`);
      continue;
    }
    seen.set(t.voucher, signature);
    if (t.scope !== ledger.scope && ledger.scope !== '第一庫＋第二庫') {
      issues.push(`${t.id}：帳簿と入出庫の範囲が不一致`);
      continue;
    }
    const quantity = units(t);
    const signed = quantity === null ? null : quantity * (t.direction === '入庫' ? 1 : -1);
    let delta = 0;
    if (t.time <= reference && !t.reflected) delta = signed;
    else if (t.time > reference && t.reflected) {
      delta = signed === null ? null : -signed;
      if (t.time > ledger.time) issues.push(`${t.id}：帳簿の版より後の取引が反映済み`);
    }
    if (delta !== 0) {
      used++;
      book = book === null || delta === null ? null : book + delta;
      steps.push(`${t.id}（${t.voucher}）：${t.time <= reference ? '基準前・未反映を加味' : '基準後・反映済みを除く'} ${delta === null ? '換算不可' : `${delta > 0 ? '+' : ''}${delta}個`}`);
    }
  }
  // 調整済み版を採用する。Jをさらに加算すると二重処理になるため、警告の根拠だけに使う。
  for (const j of adjustments) {
    steps.push(`${j.id}：${j.target}を対象に${j.quantity}個、${j.time.slice(11)}記帳。帳簿に再加算しない`);
    if (j.time > ledger.time) issues.push(`${j.id}：選択した帳簿の版より後の調整`);
  }
  const old = ledgers.length > 1 ? units(ledgers[0]) : null;
  const difference = count === null || book === null ? null : count - book;
  steps.push(`${ledger.id}を採用：基準時点の帳簿 ${book ?? '換算不可'}個 ／ 棚卸 ${count ?? '換算不可'}個`);
  return {
    difference, ledger: book, counted: count, oldDifference: old === null || count === null ? null : count - old,
    steps, provisional: issues.length > 0 || difference === null,
    conditions: issues.length ? `暫定：${[...new Set(issues)].join('、')}` : '単位・保管場所・基準時点がそろっています（記録上）',
    explanation: adjustments.length ? `同じ棚卸表を対象にした調整履歴：${adjustments.map(j => j.id).join('・')}` : used ? `反映時点の換算に使った記録：${used}行。元の伝票の確認が必要` : '差を説明する入出庫・調整履歴はありません',
    adjustments,
  };
}
