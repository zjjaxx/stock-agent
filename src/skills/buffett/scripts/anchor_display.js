/**
 * 评分表「对照说明」列（不再读 f100 校准锚；得分只看池内同类分位 / n=1 自身历史）。
 */

/** @returns {string} 评分表对照列文案 */
export function formatDimAnchor(dimId, _f100 = "") {
  switch (dimId) {
    case "pay":
      return "池内同类分位（越高越好）；>100% 该维 0";
    case "div_yield":
      return "池内同类分位（TTM股息率越高越好；已过国债×2门槛）";
    case "roe":
      return "池内同类分位（越高越好）";
    case "pb":
      return "池内同类分位（越低越好）；n=1 无自身 PB 史→缺维";
    case "debt":
      return "池内同类分位（越低越好）；银行/保险不适用";
    case "fcf":
      return "池内同类分位（覆盖越高越好）；任一年 cover<1 最多 50";
    case "dividend_discipline":
      return "池内同类分位（下调次数越少越好）";
    case "roe_stability":
      return "池内同类分位（ROE 的 CV 越低越好）";
    case "roic_durability":
      return "池内同类分位（5 年 ROIC 中位越高越好）";
    case "margin_durability":
      return "池内同类分位（5 年毛利率 σ 越低越好）";
    case "asset":
      return "不良越低、拨备越高越好（各半分位合成）";
    case "npl_formation":
      return "池内同类分位（不良净生成率越低越好；口径=Δ不良余额/期初贷款）";
    case "npl_gap":
      return "池内同类分位（逾期/不良越低越好；东财 OVERDUE_LOANS，非严格90天）";
    case "nonint":
      return "池内同类分位（非息收入/营业总收入越高越好）";
    case "cet1":
      return "池内同类分位（核充越高越好）";
    case "nim_trend":
      return "池内同类分位（两年 NIM 变动越高越好；水平仅备注）";
    case "solvency":
      return "池内同类分位（偿付充足率越高越好）";
    case "solvency_trend":
      return "池内同类分位（两年偿付变动越高越好；无 IRR 时作资本轨迹替代）";
    case "nbv_growth":
      return "池内同类分位（寿险 NBV 同比增速越高越好）";
    case "nbv_margin":
      return "池内同类分位（NBV 率越高越好；营运利润/EV 替代）";
    case "net_roi":
      return "池内同类分位（净投资收益率越高越好）";
    case "total_roi":
      return "池内同类分位（总投资收益率越高越好；年报空可中报回退）";
    case "risk_coverage":
      return "池内同类分位（风险覆盖率越高越好）";
    case "capital_leverage":
      return "池内同类分位（资本杠杆率越高越好）";
    case "pledge_cover":
      return "池内同类分位（质押履约保障比例越高越好）";
    case "margin_growth":
      return "池内同类分位（利息收入同比越高越好；两融代理）";
    case "prop_growth":
      return "池内同类分位（投资收益同比越高越好；自营代理）";
    case "fee_share":
      return "池内同类分位（手续费/营收越高越好）";
    case "fee_growth":
      return "池内同类分位（手续费同比越高越好；投行/资管代理）";
    case "dps_growth":
      return "池内同类分位（DPS 同比增速越高越好）";
    case "interest_cover":
      return "池内同类分位（利息保障倍数越高越好）";
    case "receivables":
      return "池内同类分位（应收周转天数越低越好）";
    case "ocf_quality":
      return "池内同类分位（经营现金流/净利润越高越好）";
    case "earnings_growth":
      return "池内同类分位（营收/净利同比均值越高越好）";
    case "cycle_heat":
      return "毛利率自身历史分位越高越警惕（商品价格分位代理）";
    case "gm_level":
      return "池内同类分位（5年毛利中位越高越好；成本位置代理）";
    case "net_leverage":
      return "池内同类分位（有息负债率越低越好）";
    case "capex_discipline":
      return "池内同类分位（资本开支/经营现金流越低越好）";
    case "contract_liab_trend":
      if (/白酒|饮料|乳品|调味|食品|中药|家居|广告|零售|啤酒/.test(String(_f100))) {
        return "池内同类分位（合同负债同比越低越好；防渠道压货）";
      }
      return "池内同类分位（合同负债同比越高越好；渠道打款）";
    case "gm_trend":
      return "池内同类分位（毛利率年变动越高越好；吨价代理）";
    case "pe":
      return "池内同类分位（PE越低越好；无个股历史分位）";
    case "roi_trend":
      return "池内同类分位（投资收益趋势越高越好）";
    default:
      return "池内同类分位；n=1 时自身历史≥3 年，否则缺维 ⚠️";
  }
}

/** 评分表合计行摘要 */
export function formatScoreAnchorFooter(score, f100 = "") {
  const n = score?.peer?.n ?? "—";
  const key = score?.peer?.key || (f100 ? `f100:${f100}` : "—");
  return `评分尺：池内同类分位｜${key}｜同行 n=${n}｜n=1 自身历史≥3 年否则 ⚠️`;
}
