import stickerManifest from "../../public/stickers/fanmili-family-stickers-50/manifest.json";

export type FanmiliSticker = {
  id: string;
  category: string;
  categoryZh: string;
  text: string;
  src: string;
};

const categoryKeywords: Record<string, string[]> = {
  cui_fan: ["吃饭", "饭点", "饭", "饿", "菜凉", "洗碗", "回来"],
  cui_ren_wu: ["任务", "催任务", "拖延", "快点", "完成", "监督", "做完"],
  jia_ting_jue_ding: ["决定", "投票", "同意", "反对", "弃权", "举手", "折中", "通过"],
  ri_chang_tu_cao: ["吐槽", "无语", "不想动", "合理", "谢谢", "明天", "看着", "忙"],
  lao_ren_zhuan_yong: ["老人", "慢点", "听见", "字大", "照片", "看看", "年轻人"],
  ai_zhuan_yong: ["饭米粒", "AI", "理解", "记下来", "确认", "总结", "整理", "不敢猜"]
};

export const fanmiliStickers: FanmiliSticker[] = stickerManifest.items.map((item) => ({
  id: item.id,
  category: item.category,
  categoryZh: item.category_zh,
  text: item.text,
  src: withAppBasePath(`/stickers/fanmili-family-stickers-50/${item.file}`)
}));

const stickersById = new Map(fanmiliStickers.map((sticker) => [sticker.id, sticker]));

export function findFanmiliSticker(stickerId?: string) {
  return stickerId ? stickersById.get(stickerId) : undefined;
}

export function searchFanmiliStickers(query: string, limit = 8) {
  const normalizedQuery = normalizeKeyword(query);
  if (!normalizedQuery || !/[\u3400-\u9fff]/u.test(normalizedQuery)) {
    return [];
  }

  return fanmiliStickers
    .map((sticker, index) => ({
      sticker,
      index,
      score: stickerScore(sticker, normalizedQuery)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((candidate) => candidate.sticker);
}

function stickerScore(sticker: FanmiliSticker, query: string) {
  const text = normalizeKeyword(sticker.text);
  const category = normalizeKeyword(sticker.categoryZh);
  const aliases = categoryKeywords[sticker.category] || [];

  if (text === query) return 100;
  if (text.startsWith(query)) return 80 - Math.min(20, text.length - query.length);
  if (text.includes(query)) return 64 - Math.min(20, text.length - query.length);
  if (query.includes(text)) return 58 - Math.min(20, query.length - text.length);
  if (category.includes(query) || query.includes(category)) return 44;
  if (aliases.some((alias) => {
    const normalizedAlias = normalizeKeyword(alias);
    return normalizedAlias.includes(query) || query.includes(normalizedAlias);
  })) return 36;
  return 0;
}

function normalizeKeyword(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/[\s，。！？、,.!?：:；;“”‘’（）()【】\[\]]+/g, "");
}
import { withAppBasePath } from "./appBasePath";
