// IFCファイルから見積CADインポート用のフラット配列（file/suuryo/kakaku/name/type/parameters）を
// 画面表示なしで抽出する共通モジュール。
// ロジックは ifc-viewer.html の buildQuantityTable() / transferToEstimateBtn の変換処理と同一にしてある
// （分類判定・パラメータ抽出・JSON化のルールを二重管理しないよう、変更する際は両方に反映すること）。
import { IFCLoader } from 'web-ifc-three/IFCLoader';
import {
  IFCWALL, IFCWALLSTANDARDCASE, IFCSLAB, IFCREINFORCINGMESH, IFCROOF,
  IFCCOLUMN, IFCFURNISHINGELEMENT, IFCBUILDINGELEMENTPROXY, IFCRAMP, IFCWINDOW,
} from 'web-ifc';

const WASM_PATH = 'https://unpkg.com/web-ifc@0.0.39/';

const ALL_SCAN_TYPES = [
  IFCWALL, IFCWALLSTANDARDCASE, IFCSLAB, IFCREINFORCINGMESH, IFCROOF,
  IFCCOLUMN, IFCFURNISHINGELEMENT, IFCBUILDINGELEMENTPROXY, IFCRAMP, IFCWINDOW,
];
const CATEGORY_NAMES = ['壁', 'スラブ', 'メッシュ', '屋根', '柱', 'オブジェクト', 'ランプ', '植栽', '窓'];
const CATEGORY_PARAMS = {
  '壁': ['高さ', '壁中心長さ', '表面積'],
  'スラブ': ['高さ', '平面図外周', '面積'],
  'メッシュ': ['平面図外周', '上部表面積(正味)'],
  '屋根': ['表面積'],
  '柱': ['躯体高さ/直径', '最大高さ'],
  'オブジェクト': ['数量', 'フェンス本体枚数', '枚数', 'フリー支柱'],
  'ランプ': ['数量'],
  '植栽': ['数量'],
  '窓': ['数量'],
};
const FIXED_QTY_CATEGORIES = new Set(['オブジェクト', 'ランプ', '植栽', '窓']);
const CATEGORY_TYPE = { '壁': 4, 'スラブ': 5, 'メッシュ': 6, '屋根': 7, 'オブジェクト': 1, 'ランプ': 3, '窓': 8, '柱': 1 };

function fieldValue(v) {
  if (v == null) return '';
  if (typeof v === 'object' && 'value' in v) return String(v.value);
  return String(v);
}

function detectCategory(name) {
  if (!name) return null;
  const normalized = name.trim().normalize('NFKC');
  const m = /^(.+?)[-－―ー]\d+$/.exec(normalized);
  const prefix = m ? m[1] : normalized;
  return CATEGORY_NAMES.includes(prefix) ? prefix : null;
}

function resolveCategory(elementName, psets) {
  const trueType = readArchicadText(psets, '要素タイプ');
  if (trueType) {
    const normalized = trueType.trim().normalize('NFKC');
    if (CATEGORY_NAMES.includes(normalized)) return normalized;
  }
  return detectCategory(elementName);
}

function namesMatch(actualName, targetName) {
  return !!actualName && actualName.trim().normalize('NFKC') === targetName;
}

function readParamValue(psets, paramName, psetName) {
  for (const pset of psets) {
    if (psetName && fieldValue(pset.Name) !== psetName) continue;
    const items = pset.HasProperties || pset.Quantities || [];
    for (const p of items) {
      if (!namesMatch(fieldValue(p.Name), paramName)) continue;
      const raw = p.NominalValue ?? p.AreaValue ?? p.LengthValue ?? p.VolumeValue
        ?? p.WeightValue ?? p.CountValue ?? p.TimeValue;
      const num = parseFloat(fieldValue(raw));
      if (!Number.isNaN(num)) return num;
    }
  }
  return null;
}

function readArchicadText(psets, paramName) {
  return findPropText(psets, paramName, 'ArchiCADProperties') || findPropText(psets, paramName, null);
}

function findPropText(psets, paramName, psetName) {
  for (const pset of psets) {
    if (psetName && fieldValue(pset.Name) !== psetName) continue;
    const items = pset.HasProperties || [];
    for (const p of items) {
      if (!namesMatch(fieldValue(p.Name), paramName)) continue;
      const text = fieldValue(p.NominalValue);
      if (text) return text;
    }
  }
  return null;
}

let _loader = null;
function getLoader() {
  if (!_loader) {
    _loader = new IFCLoader();
    _loader.ifcManager.setWasmPath(WASM_PATH);
  }
  return _loader;
}

// 分類・パラメータ抽出（buildQuantityTableと同じロジック）。見積に必要かどうかはここでは判別せず、
// 対象9分類（壁/スラブ/メッシュ/屋根/柱/オブジェクト/ランプ/植栽/窓）の要素を丸ごと返す。
async function scanCategorizedRows(modelID, manager) {
  const targets = [];
  for (const t of ALL_SCAN_TYPES) {
    let items = [];
    try { items = await manager.getAllItemsOfType(modelID, t, true); } catch (err) { items = []; }
    for (const props of items) {
      const elementName = fieldValue(props.Name) || '';
      const category = detectCategory(elementName);
      if (category) targets.push({ id: props.expressID, elementName, category });
    }
  }

  return Promise.all(targets.map(async ({ id, elementName, category: nameCategory }) => {
    let psets = [];
    try { psets = await manager.getPropertySets(modelID, id, true); } catch (err) { psets = []; }
    const category = resolveCategory(elementName, psets) || nameCategory;
    const fixedQty = FIXED_QTY_CATEGORIES.has(category);

    let label;
    if (category === '植栽') {
      label = readArchicadText(psets, '樹木名称') || elementName || `ID${id}`;
    } else if (fixedQty) {
      label = readArchicadText(psets, '名称') || readArchicadText(psets, '呼称')
        || readArchicadText(psets, 'ライブラリ部品名') || elementName || `ID${id}`;
    } else {
      label = readArchicadText(psets, '材質(全て)') || '(材質未設定)';
    }

    const params = {};
    for (const paramName of CATEGORY_PARAMS[category]) {
      if (fixedQty && paramName === '数量') {
        params['数量'] = 1;
        continue;
      }
      const val = readParamValue(psets, paramName);
      if (val != null) params[paramName] = val;
    }

    // RIKCAD_PSETの「メーカー名」「引出線名称」。見つからなければnull→空文字（要素にRIKCAD_PSETが
    // 無い/該当プロパティが空でもエラーにせず空扱いにする。ifc-viewer.htmlのbuildQuantityTableと同じ扱い）
    const maker = readArchicadText(psets, 'メーカー名') || '';
    const hikidashi = readArchicadText(psets, '引出線名称') || '';

    return { id, category, label, params, maker, hikidashi };
  }));
}

// RIKCAD互換のフラット配列（file/suuryo/kakaku/name/type/parameters）に変換する
// （ifc-viewer.htmlのtransferToEstimateBtnと同一ロジック）
function toFlatItems(rows, fileName) {
  const items = [];
  for (const r of rows) {
    const type = CATEGORY_TYPE[r.category] ?? 1;
    const p = r.params || {};
    let suuryo = 0, paramParts = [];
    // メーカー名は新規フィールドを作らず、既存の「parameters内に半角『ﾒｰｶｰ:値』行を1つ持たせる」規約に
    // 合わせる（csv_to_json_watcher.pyのbuild_parameters()、estimate-edit-demo.htmlのcadSpec()と同じ規約）。
    // ここではifc-viewer.html側のtransferToEstimateBtnと同様、値が無ければ行を追加しない
    if (r.maker) paramParts.push(`ﾒｰｶｰ:${r.maker}`);
    if (type === 4) {
      const h = p['高さ'], a = p['表面積'], l = p['壁中心長さ'];
      if (h != null) { paramParts.push(`塀高さ:${(h / 1000).toFixed(3)}m`); suuryo = parseFloat((h / 1000).toFixed(3)); }
      if (a != null) { paramParts.push(`基準線面積:${a.toFixed(3)}㎡`); }
      if (l != null) { paramParts.push(`基準線長さ:${(l / 1000).toFixed(3)}m`); if (!suuryo) suuryo = parseFloat((l / 1000).toFixed(3)); }
    } else if ([5, 6, 7].includes(type)) {
      const a = p['面積'] ?? p['表面積'] ?? p['上部表面積(正味)'];
      if (a != null) { paramParts.push(`3D上面積:${a.toFixed(3)}㎡`); suuryo = parseFloat(a.toFixed(3)); }
    } else {
      suuryo = Math.round(p['数量'] ?? 1);
    }
    // 引出線名称はifc-viewer.html側と同じくhikidashiという独立フィールドに乗せる（受け手の既存命名に合わせる）
    // 2026-08-17追加（坂東さん指示、「ツール名」列対応）: ifc-viewer.html側のitems.push()にcategory
    // フィールドを追加したのに合わせ、こちら（IFC直接読込パス）も同じJSON契約を満たすようcategoryを追加する。
    // scanCategorizedRows()が既に分類を確定させて返しているr.categoryをそのまま使う（新規の判定ロジックは不要）。
    items.push({ file: fileName, name: r.label, type, suuryo, kakaku: 0, parameters: paramParts.join('\n'), hikidashi: r.hikidashi || '', category: r.category || '' });
  }
  return items;
}

// IFCファイル(ArrayBuffer)から、見積の「CADから引用」で使うフラット配列を抽出する。
// 3D表示やSupabase等の外部I/Oは一切行わない（呼び出し側でfetch・保存を行うこと）。
export async function extractIfcItems(arrayBuffer, fileName) {
  const loader = getLoader();
  const model = await loader.parse(arrayBuffer);
  const modelID = model.modelID;
  const rows = await scanCategorizedRows(modelID, loader.ifcManager);
  return toFlatItems(rows, fileName || 'model.ifc');
}
