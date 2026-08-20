/**
 * 各评分维「f100锚/标准值」列展示文案（SKILL.md §2 评分表）。
 * 日常评分脚本输出 + 桌面终报共用。均指 knot 线性插值（0–100 四舍五入）。
 */

import { anchorProfile, normalizeIndustry } from "./anchor_config.js";
import { classPbAnchor } from "./industry_map.js";

function fmtCvCuts(cuts) {
  if (!cuts?.length) return null;
  const grades = [100, 80, 50, 20];
  return cuts
    .slice(0, grades.length)
    .map((c, i) => `${c}→${grades[i]}`)
    .join("；");
}

function fmtSigmaCuts(cuts) {
  if (!cuts?.length) return null;
  const grades = [100, 80, 50, 20];
  return cuts
    .slice(0, grades.length)
    .map((c, i) => `${c}pct→${grades[i]}`)
    .join("；");
}

function isFinancial(f100) {
  return /银行|保险/.test(normalizeIndustry(f100));
}

const LIN = "（knot 线性插值）";

/** @returns {string} SKILL 规定的 f100锚/标准值 列文案 */
export function formatDimAnchor(dimId, f100 = "") {
  const profile = anchorProfile(f100);
  const m = profile.metrics;

  switch (dimId) {
    case "pay":
      if (m.pay?.band) {
        const [lo, hi] = m.pay.band;
        return `健康带 ${lo}%–${hi}%（±10pct 放宽）${LIN}`;
      }
      return "—";

    case "roe":
      return m.roe?.anchor != null ? `约≥${m.roe.anchor}%${LIN}` : "—";

    case "pb": {
      if (m.pb?.anchor != null) return `约≤${m.pb.anchor}${LIN}`;
      const soft = classPbAnchor(f100);
      return soft != null ? `约≤${soft}（类别软锚，PB未校准）${LIN}` : "仅同类分位（PB未校准，连续分位）";
    }

    case "debt":
      if (isFinancial(f100)) return "不适用";
      return m.debt?.anchor != null ? `约≤${m.debt.anchor}%${LIN}` : "—";

    case "fcf":
      return `覆盖 0.5/0.8/1.0/1.5/3.0→0/20/50/80/100${LIN}`;

    case "dividend_discipline":
      return `DPS下调 0/1/2/3 次→100/50/20/0；派息σ 10/20/30pct→80/50/20${LIN}`;

    case "roe_stability": {
      const cuts = fmtCvCuts(m.roe_cv?.cuts);
      return cuts ? `roe_cv：${cuts}${LIN}` : "—";
    }

    case "roic_durability": {
      if (m.roic?.anchor == null) return "—";
      const cv = fmtCvCuts(m.roic.cv_cuts);
      return cv
        ? `中位/锚 0.4–2.0×→0–100；CV ${cv}${LIN}`
        : `中位/锚 0.4–2.0×→0–100${LIN}`;
    }

    case "margin_durability": {
      const cuts = fmtSigmaCuts(m.margin_sigma?.cuts);
      return cuts ? `margin_σ：${cuts}${LIN}` : "—";
    }

    case "asset":
      return `不良 0–0.9–1.5–2–3–5→100–90–65–35–10–0；拨备 120–400→0–100${LIN}`;

    case "cet1":
      return `核充 8–9.5–11–13–16→10–20–50–80–100${LIN}`;

    case "nim_trend":
      return `水平 0.7–1.0–1.3–1.6–2.1→0–20–50–80–100；两年变动弱于同业中位才封顶${LIN}`;

    case "solvency":
      return `偿付 100–150–180–220–280→10–50–80–90–90（超额封顶90）${LIN}`;

    case "solvency_trend":
      return `自身变动−同业中位（pct）；knot -25–-15–-8–0–10–20→0–20–50–70–90–100；同业<3 用自身变动线性${LIN}`;

    case "roi_trend":
      return `相对变动 -15%–-5%–0–5%–15%→0–20–50–80–100${LIN}`;

    default:
      return "—";
  }
}

/** 评分表合计行锚摘要 */
export function formatScoreAnchorFooter(score, f100 = "") {
  const a = score?.anchors;
  if (!a) return "锚版本 —";
  const n = a.sources?.roe?.n ?? a.sources?.pay?.n ?? "—";
  return `锚版本 \`${a.version}\`｜f100=${a.f100 || f100 || "—"}｜N=${n}`;
}
