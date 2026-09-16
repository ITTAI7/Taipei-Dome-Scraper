import * as fs from 'fs';
import * as path from 'path';
import { TicketZone } from './ITicketScraper.js';

// 各球團共用的大巨蛋分區容量表載入／回推工具。
// v3（大巨蛋座位v3.json）是以台鋼官方 activity-venues API 的 seatCount 為主要來源
// （查無資料的少數分區才 fallback 回 v1 舊資料），比 v1 從 ibon 座位圖回推的數字更準確，
// 詳見 大巨蛋座位v2.json 的 _說明 與 DEVLOG.md 2026-09-14 條目。
// 樂天／統一／明星賽三隊目前仍各自讀 v1（大巨蛋座位.json），尚未切換到這份檔案，
// 避免同時變動既有行為；新加入的球團（如中信兄弟）請直接用這裡的 v3 loader。
export const DOME_SEAT_MAP_V3_FILE = '大巨蛋座位v3.json';

type SeatMapEntry = [string, number, number];

export function loadSeatCapacityMap(fileName: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const jsonPath = path.resolve(process.cwd(), fileName);
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const entries: SeatMapEntry[] = JSON.parse(raw);
    for (const [floor, zoneNum, capacity] of entries) {
      map.set(`${floor}-${zoneNum}`, capacity);
    }
    console.log(`Loaded ${map.size} dome seat entries from ${fileName}`);
  } catch (e) {
    console.warn(`無法載入 ${fileName}，容量回推功能將無法作用:`, (e as Error).message);
  }
  return map;
}

export function extractFloorZone(zoneName: string): { floor: string; zoneNum: number } | null {
  const floorMatch = zoneName.match(/(B1|L2|L4|L5)/i);
  const zoneMatch = zoneName.match(/(\d+)\s*區/);
  if (!floorMatch || !zoneMatch) return null;
  return { floor: floorMatch[1].toUpperCase(), zoneNum: parseInt(zoneMatch[1], 10) };
}

// ⚠️ 2026-09-16 查核：中信兄弟確實會把同一分區拆成「前排／後排」兩列分開賣
// （例：B1內野105區前排／後排、106區前排／後排…），而且拆法跟台鋼不完全一樣——
// 台鋼只有 106~120 之間 13 區有拆前/後（TP106B/TP106F 這種代號），105、121 區
// 台鋼是單一代號（TP105、TP121）沒有拆，但兄弟自己的售票網站這兩區也拆了。
// v3 容量表裡每個 floor-zoneNum 存的是「整區」總容量（前+後合計），沒有各自
// 前/後排的容量拆分數字，所以**不能**對拆分區的每一列都直接套用整區容量
// （那樣會把同一區的容量重複算兩次）。
//
// 因此這裡採用跟 ibon 三隊 patchDomeCapacity() 相同的「同區歸戶」策略：
// 用 extractFloorZone() 把同一 floor-zoneNum 底下的所有列（不論有沒有拆前/後）
// 先分組，只有「這一組裡至少有一列已經抓到真實座位數」時，才把整區容量扣掉
// 已知的部分、把剩餘容量塞給還未知的那一列（例如前排抓到了、後排 WAF 被擋，
// 剩餘容量就是後排的量）。如果整組全部都抓不到（例如整區被 WAF 擋、或分區
// 本來就沒拆、單獨這一列失敗且沒有其他列可以比對），才允許直接用整區容量
// 回填（因為此時這一組只有一列，填進去不會有「重複計算」的風險）。
// 如果一組有 2 列以上但全部失敗，因為不知道容量該怎麼分配給前/後排，維持
// 未知，不亂猜——寧可誠實顯示抓不到，也不要用錯的數字掩蓋抓取失敗。
// 輪椅／陪伴席容量表沒有涵蓋，故整段略過不補。
export function patchDomeCapacity(details: TicketZone[], capacityMap: Map<string, number>): void {
  const blockMap = new Map<string, { knownTotal: number; hasRealData: boolean; missingIndices: number[] }>();
  details.forEach((d, index) => {
    if (d.zone.includes('輪椅') || d.zone.includes('陪伴')) return;
    const fz = extractFloorZone(d.zone);
    if (!fz) return;
    const key = `${fz.floor}-${fz.zoneNum}`;
    if (!blockMap.has(key)) blockMap.set(key, { knownTotal: 0, hasRealData: false, missingIndices: [] });
    const block = blockMap.get(key)!;
    if (typeof d.total === 'number' && d.total >= 0) {
      block.knownTotal += d.total;
      block.hasRealData = true;
    } else {
      block.missingIndices.push(index);
    }
  });

  for (const [key, block] of blockMap.entries()) {
    if (block.missingIndices.length === 0) continue;
    // 整組只有一列（該分區本來就沒拆前/後）時，就算這一列本身沒有其他列可以比對，
    // 也可以放心直接用整區容量回填，因為不存在「跟另一列重複計算」的風險。
    const isSoloZone = block.missingIndices.length === 1 && !block.hasRealData;
    if (!block.hasRealData && !isSoloZone) continue;
    const capacity = capacityMap.get(key);
    if (capacity === undefined) continue;
    const remainingCapacity = Math.max(0, capacity - block.knownTotal);
    block.missingIndices.forEach((detailIndex, i) => {
      const d = details[detailIndex];
      if (i === 0) {
        if (d.unsold >= 0) d.sold = Math.max(0, remainingCapacity - d.unsold);
        d.total = remainingCapacity;
        d.error = d.error ? `${d.error} (自動補齊同區剩餘總數)` : '(自動補齊同區剩餘總數)';
      } else {
        // 同一組還有第二列以上仍未知：容量已經被上面那列吃掉，這裡沒有依據
        // 再拆給第二列，維持未知並註記，避免重複計算。
        d.total = -1;
        d.sold = -1;
        d.error = d.error ? `${d.error} (容量已併入同區)` : '(容量已併入同區)';
      }
    });
  }
}
