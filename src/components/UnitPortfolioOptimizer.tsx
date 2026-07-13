/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { ProjectInfo, Alternative, TypeConfig } from "../types";
import { calculateAlternativeMetrics } from "../utils/calculations";
import { Cpu, Sparkles, Check, Plus, Sliders, Home, Coins, AlertCircle, Info, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";

interface UnitPortfolioOptimizerProps {
  project: ProjectInfo;
  currentAlternative: Alternative;
  onApplyOptimalTypes: (types: TypeConfig[]) => void;
  onAddAlternativeWithTypes?: (name: string, types: TypeConfig[]) => void;
  onShowNotification?: (message: string, type?: "success" | "error" | "info") => void;
}

interface OptimizedPortfolio {
  name: string;
  badge: string;
  description: string;
  objectiveType: "revenue" | "units";
  types: TypeConfig[];
  metrics: {
    totalUnits: number;
    totalExclArea: number;
    totalSupplyArea: number;
    requiredParking: number;
    farUtilization: number;
    isFeasible: boolean;
  };
}

export const UnitPortfolioOptimizer: React.FC<UnitPortfolioOptimizerProps> = ({
  project,
  currentAlternative,
  onApplyOptimalTypes,
  onAddAlternativeWithTypes,
  onShowNotification,
}) => {
  // 현재 검토 중인 사용자 대안의 제약을 모태(Base)로 설정
  const [maxParking, setMaxParking] = useState<number>(currentAlternative.plannedParkingCount);
  const [maxAboveGroundArea, setMaxAboveGroundArea] = useState<number>(currentAlternative.aboveGroundFloorArea);
  const [isTuningOpen, setIsTuningOpen] = useState<boolean>(false);
  
  const [portfolios, setPortfolios] = useState<OptimizedPortfolio[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [aiReport, setAiReport] = useState<string>("");
  const [isAiLoading, setIsAiLoading] = useState<boolean>(false);

  // 제약 최적화 기획 모델링 (Grid-Search MILP Approximation)
  const solveOptimization = (overrideParking?: number, overrideArea?: number) => {
    // 59㎡, 84㎡, 114㎡ 세대 대표 라인업
    const specs = [
      { name: "59A", excl: 59.9, comm: 18.5, supply: 78.4 },
      { name: "84A", excl: 84.9, comm: 24.8, supply: 109.7 },
      { name: "114A", excl: 114.8, comm: 32.2, supply: 147.0 }
    ];

    // 대지가 허용하는 법적 최대 지상 연면적(allowable max area) 및 주차 설계 상 한계 한동 산출
    const legalMaxFarArea = ((project.lotArea - project.roadArea) * project.allowableFloorAreaRatio) / 100;
    
    // AI 대안 조합기는 단순히 사용자의 축소 범위에 억매이지 않고, 대지 사업성을 극대화하는 관점에서 
    // 법정 연면적 상한의 최소 60% 이상 수준 또는 사용자 설정값 중 극대화 탐색 범위를 실시간으로 도출합니다.
    const currentMaxArea = Math.max(
      overrideArea !== undefined ? overrideArea : maxAboveGroundArea,
      legalMaxFarArea * 0.65,
      2800 // 최소 탐색 가이드선 2800㎡ 확보
    );

    const checkParkingForMix = (mix: { [key: string]: number }) => {
      let parkingByArea = 0;
      let parkingByUnitMin = 0;
      
      specs.forEach(spec => {
        const qty = mix[spec.name] || 0;
        if (qty === 0) return;
        
        if (spec.excl <= 85) {
          parkingByArea += (spec.excl * qty) / 75;
        } else {
          parkingByArea += (spec.excl * qty) / 65;
        }
        
        if (spec.excl <= 60) {
          parkingByUnitMin += qty * 0.7;
        } else if (spec.excl <= 85) {
          parkingByUnitMin += qty * 1.0;
        } else {
          parkingByUnitMin += qty * 1.3;
        }
      });
      return Math.ceil(Math.max(parkingByArea, parkingByUnitMin));
    };

    // 면전 전도율에 최적화된 주차대수 한도 동적 보장 (주차가 굳어 마비되는 현상 방지)
    const calculatedParkingCeiling = Math.ceil(currentMaxArea / 36);
    const currentMaxParking = Math.max(
      overrideParking !== undefined ? overrideParking : maxParking,
      calculatedParkingCeiling,
      120 // 최소 안정 범위 120대 설정
    );

    const netArea = Math.max(100, project.lotArea - project.roadArea);

    const runOptimizationForObjective = (obj: "revenue" | "units") => {
      let bestMix = { "59A": 0, "84A": 0, "114A": 0 };
      let bestScore = -1;

      // c114Max 계산을 루프 밖 및 안에서 유연하게 한정하고, 단계 정밀도를 (step = 2)로 촘촘히 튜닝해 실제 실시간 새로고침 시 기민한 결과가 피드백되도록 구성
      for (let c59 = 0; c59 <= 350; c59 += 2) {
        for (let c84 = 0; c84 <= 250; c84 += 2) {
          const currentSupplySoFar = c59 * specs[0].supply + c84 * specs[1].supply;
          const remainingArea = currentMaxArea - currentSupplySoFar;
          if (remainingArea < 0) continue;

          // 대형 평형(114A)이 들어갈 수 있는 물리적인 상한 세대수를 지능적으로 계산하여 불필요한 루프 무효화
          const maxC114Allowed = Math.floor(remainingArea / specs[2].supply);
          const c114Limit = Math.min(180, maxC114Allowed);

          for (let c114 = 0; c114 <= Math.max(0, c114Limit); c114 += 2) {
            const tempMix = { "59A": c59, "84A": c84, "114A": c114 };
            const totalUnits = c59 + c84 + c114;
            if (totalUnits === 0) continue;

            const tempSupplyArea = currentSupplySoFar + c114 * specs[2].supply;
            if (tempSupplyArea > currentMaxArea) continue;

            const requiredParking = checkParkingForMix(tempMix);
            if (requiredParking > currentMaxParking) continue;

            let score = 0;
            if (obj === "revenue") {
              // 분양매출 가치 가중 산정: (큰 평형 우대비율 + 전용면적 점유율의 합)
              score = tempSupplyArea * 1.5 + c114 * 120 + c84 * 40;
            } else {
              // 가구/세대밀도 극대화형: (총 세대수 기반 + 소형 평형 우대비율)
              score = totalUnits * 1000 - tempSupplyArea * 0.1 + c59 * 50;
            }

            if (score > bestScore) {
              bestScore = score;
              bestMix = tempMix;
            }
          }
        }
      }

      // 만약 매우 엄격한 제약조건으로 인해 탐색에 실패한 경우, 실시간 기획안 비율에 가공해 맞춤 안전값 수립
      if (bestScore === -1) {
        const estUnits = Math.max(40, Math.floor(currentMaxArea / 100));
        bestMix = obj === "revenue"
          ? { "59A": Math.floor(estUnits * 0.15), "84A": Math.floor(estUnits * 0.45), "114A": Math.floor(estUnits * 0.4) }
          : { "59A": Math.floor(estUnits * 0.6), "84A": Math.floor(estUnits * 0.35), "114A": Math.floor(estUnits * 0.05) };
      }

      const finalTypes: TypeConfig[] = [
        { id: `ai-opt-t1-${obj}`, name: "59A", exclArea: specs[0].excl, commArea: specs[0].comm, count: bestMix["59A"] },
        { id: `ai-opt-t2-${obj}`, name: "84A", exclArea: specs[1].excl, commArea: specs[1].comm, count: bestMix["84A"] },
        { id: `ai-opt-t3-${obj}`, name: "114A", exclArea: specs[2].excl, commArea: specs[2].comm, count: bestMix["114A"] }
      ].filter(t => t.count > 0);

      const totalUnits = finalTypes.reduce((sum, t) => sum + t.count, 0);
      const totalExclArea = finalTypes.reduce((sum, t) => sum + t.exclArea * t.count, 0);
      const totalSupplyArea = finalTypes.reduce((sum, t) => sum + (t.exclArea + t.commArea) * t.count, 0);
      const requiredParking = checkParkingForMix(bestMix);
      const farUtil = (totalSupplyArea / netArea) * 100;

      return {
        types: finalTypes,
        metrics: {
          totalUnits,
          totalExclArea,
          totalSupplyArea,
          requiredParking,
          farUtilization: farUtil,
          isFeasible: requiredParking <= currentMaxParking && totalSupplyArea <= currentMaxArea
        }
      };
    };

    const revRes = runOptimizationForObjective("revenue");
    const unitsRes = runOptimizationForObjective("units");

    const calculatedPortfolios: OptimizedPortfolio[] = [
      {
        name: "💰 AI 분양 수익 극대화 추천 조합",
        badge: "수익 가치형",
        description: `현재 용도지역 기준 대비 대형 평수 비율을 끌어올려 마일리지를 확보하는 세대 믹스안입니다.`,
        objectiveType: "revenue",
        types: revRes.types,
        metrics: revRes.metrics
      },
      {
        name: "👨‍👩‍👧‍👦 AI 공급/세대수 극대화 추천 조합",
        badge: "밀집 효율형",
        description: `국민 중심 가성비 타입 비율을 확대 배분하고, 세대당 주임 법적요건을 극적으로 꽉 채우는 유닛 조합입니다.`,
        objectiveType: "units",
        types: unitsRes.types,
        metrics: unitsRes.metrics
      }
    ];

    setPortfolios(calculatedPortfolios);
  };

  // 1. 대안 및 세대 타입수 구성이 바뀔 때 한계치를 슬라이더 상태와 일관되게 연동
  useEffect(() => {
    const freshParking = currentAlternative.plannedParkingCount;
    const freshArea = currentAlternative.aboveGroundFloorArea;
    setMaxParking(freshParking);
    setMaxAboveGroundArea(freshArea);
  }, [
    currentAlternative.id,
    currentAlternative.plannedParkingCount,
    currentAlternative.aboveGroundFloorArea,
    JSON.stringify(currentAlternative.types)
  ]);

  // 2. 슬라이더 설정치나 프로젝트 속성이 바뀔 때 즉각 실시간 최적화 재산출 기동
  useEffect(() => {
    solveOptimization(maxParking, maxAboveGroundArea);
  }, [
    maxParking,
    maxAboveGroundArea,
    project
  ]);

  // 수동 최적화 및 리포트/포트폴리오 리프레시 강제 기동 핸들러
  const handleRefreshOptimization = () => {
    const freshParking = currentAlternative.plannedParkingCount;
    const freshArea = currentAlternative.aboveGroundFloorArea;
    
    setMaxParking(freshParking);
    setMaxAboveGroundArea(freshArea);
    solveOptimization(freshParking, freshArea);
    
    if (onShowNotification) {
      onShowNotification("🔄 대안의 최신 세대수 및 연면적 설정을 동기화하여 AI 하이브리드 조합 추천안을 성공적으로 갱신하였습니다.", "success");
    }
  };

  // 대안 세대 믹스를 현재 대안에 로딩
  const handleApplyToCurrent = (idx: number) => {
    const selected = portfolios[idx];
    if (selected) {
      onApplyOptimalTypes(selected.types);
      if (onShowNotification) {
        onShowNotification(`[${selected.name}]의 유닛 구성을 현재 설계안에 성공적으로 대입 통합하였습니다.`, "success");
      } else {
        alert(`[${selected.name}]의 세대수 및 전용 분배 플랜이 현재 활성화된 [${currentAlternative.name}] 설계상에 성공적으로 대입 통합되었습니다! 오른편 비교 대시보드에 연동 적용됩니다.`);
      }
    }
  };

  // 대안 세대 믹스를 새 임의의 대안으로 연동 추가
  const handleCreateAsNewAlternative = (idx: number) => {
    const selected = portfolios[idx];
    if (selected && onAddAlternativeWithTypes) {
      const typeLabel = selected.objectiveType === "revenue" ? "수익극대화 AI추천안" : "세대극대화 AI추천안";
      const customizedName = `[AI 수렴안] ${currentAlternative.name.split(" (")[0]} - ${typeLabel}`;
      onAddAlternativeWithTypes(customizedName, selected.types);
      if (onShowNotification) {
        onShowNotification(`🎉 완전히 새로운 대안 [${customizedName}] 설계가 목록에 추가 복제되었습니다!`, "success");
      } else {
        alert(`🎉 추천 설계안이 [${customizedName}] 이라는 이름의 완전히 새로운 대안으로 추가 복제되었습니다!`);
      }
    }
  };

  const generateAiOptimizationReview = async () => {
    setIsAiLoading(true);
    setAiReport("");
    try {
      const prompt = `대한민국 최고 권위의 기획설계 자문단으로서, 사용자가 기획 중인 기본 대안([${currentAlternative.name}])과, 이 세대 규격을 최적화 정렬한 2가지 핵심 AI 하이브리드 추천 믹스를 면밀히 비교 진단하는 '디벨로퍼 투자심의 자문 의견서'를 한국어로 지극히 품격 있게 작성해 주세요.

[타겟 베이스라인 대안명]
- ${currentAlternative.name}
- 현재 수치: 세대수 ${currentAlternative.totalGenerationCount || 0}세대, 지상면적 ${currentAlternative.aboveGroundFloorArea.toLocaleString()}㎡, 주차계획 ${currentAlternative.plannedParkingCount}대

[연동 최적화 추천 2개 세트]
${portfolios.map((p, i) => `
추천안 ${i + 1}: ${p.name} (${p.badge})
- 구성비율 세대수: ${p.metrics.totalUnits}세대
- 유닛 조합: ${p.types.map(t => `${t.name}(${t.count}세대)`).join(", ")}
- 필요한 산정 주차: ${p.metrics.requiredParking}대
- 예측 분양 연면적 소계: ${p.metrics.totalSupplyArea.toFixed(1)}㎡
`).join("\n")}

각 추천안별 사업 가속 조건, 예상 마진 시나리오, 인허가 리스크 및 대한민국 주차장법 마진을 조화롭게 대조하여, 의사결정권자가 안심하고 최선의 결정을 내릴 수 있도록 실전 엔지니어링 브리핑 답변을 완성해 수록해 주시기 바랍니다.`;

      const metrics = calculateAlternativeMetrics(project, currentAlternative);
      const enrichedAlternative = {
        ...currentAlternative,
        ...metrics
      };

      const response = await fetch("/api/gemini/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectData: project,
          currentAlternative: enrichedAlternative,
          userMessage: prompt
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `서버 에러 (HTTP ${response.status})`);
      }
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error);
      }
      setAiReport(data.text || "의견 조율 브리핑 추출 실패");
    } catch (error: any) {
      console.error(error);
      setAiReport(`⚠️ AI 진단 도중 일시적인 네트워크 지연이 발생했거나 모델 가용 용량이 부족합니다. 다시 요청을 기동해 타진해주시기 바랍니다.\n\n[세부 설명]: ${error.message || error}`);
    } finally {
      setIsAiLoading(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded shadow-sm p-4 text-[12px] mt-4" id="portfolio-optimizer-container">
      {/* Header Banner */}
      <div className="flex items-start justify-between border-b border-gray-100 pb-3 mb-3.5">
        <div className="flex items-center gap-2">
          <div className="bg-cyan-950 text-yellow-400 p-1.5 rounded shadow-inner">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="font-bold text-slate-900 text-xs tracking-tight">
                AI 연동 하이브리드 세대 조합 진단기
              </h3>
              <span className="bg-slate-500/10 text-slate-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-slate-500/20">
                ACTIVE BASE: {currentAlternative.name.split(" ")[0]}
              </span>
            </div>
            <p className="text-[10px] text-slate-400 mt-0.5">
              활성화된 manual 입력 대안을 원형 베이스 삼아, 최상의 실무 기획 수치 모델 2가지 버전을 연동 탐색합니다.
            </p>
          </div>
        </div>

        {/* 액션 컨트롤 버튼 그룹 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* 수동 AI 대안 새로고침 버튼 */}
          <button
            type="button"
            onClick={handleRefreshOptimization}
            className="text-[11px] px-2.5 py-1 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300 text-indigo-700 rounded flex items-center gap-1 font-semibold transition-all cursor-pointer"
            title="현재 타입별 세대 설계안 기준에 맞추어 AI 추천 조합을 즉시 새로고침합니다"
          >
            <RefreshCw className="w-3 h-3 text-indigo-500 animate-hover-spin" />
            <span>AI 조합 새로고침</span>
          </button>

          {/* 미세 조정 기동 스위치 */}
          <button
            type="button"
            onClick={() => setIsTuningOpen(!isTuningOpen)}
            className="text-[11px] px-2.5 py-1 bg-slate-50 hover:bg-slate-100 border border-slate-200 hover:border-slate-300 text-slate-600 rounded flex items-center gap-1 font-semibold transition-all cursor-pointer"
          >
            <Sliders className="w-3 h-3 text-slate-400" />
            <span>AI 한계 제약 수치 가감 {isTuningOpen ? "닫기" : "열기"}</span>
            {isTuningOpen ? <ChevronUp className="w-3 h-3 text-slate-400" /> : <ChevronDown className="w-3 h-3 text-slate-400" />}
          </button>
        </div>
      </div>

      {/* Collapsible Tuning Panel */}
      {isTuningOpen && (
        <div className="mb-4 bg-slate-50/70 p-3.5 rounded border border-slate-200/60 text-slate-700 space-y-3.5 transition-all">
          <div className="flex items-center gap-1 text-[11px] font-bold text-slate-800">
            <Sliders className="w-3.5 h-3.5 text-indigo-600" />
            <span>AI 최적화 연산용 한계치 튜닝 모듈</span>
            <span className="text-[9px] text-slate-400 font-normal ml-1">
              (기본값은 현재 검토 대안에서 직접 매칭 공급 설계됩니다)
            </span>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 text-[11px]">
            <div className="bg-white p-2.5 rounded border border-slate-200">
              <label className="block text-slate-600 font-bold mb-1">
                🚗 주차 수용 한계선 튜닝
              </label>
              <input
                type="range"
                min="50"
                max="500"
                step="10"
                value={maxParking}
                onChange={(e) => setMaxParking(parseInt(e.target.value))}
                className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              />
              <div className="flex justify-between text-[9.5px] font-mono mt-1 text-slate-500">
                <span>하한: 50대</span>
                <span className="text-indigo-600 font-bold font-sans">설정치: {maxParking}대</span>
                <span>상한: 500대</span>
              </div>
            </div>

            <div className="bg-white p-2.5 rounded border border-slate-200">
              <label className="block text-slate-600 font-bold mb-1">
                📐 계획 연면적 제약 튜닝
              </label>
              <input
                type="range"
                min="5000"
                max="60000"
                step="1000"
                value={maxAboveGroundArea}
                onChange={(e) => setMaxAboveGroundArea(parseInt(e.target.value))}
                className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              />
              <div className="flex justify-between text-[9.5px] font-mono mt-1 text-slate-500">
                <span>하한: 5k㎡</span>
                <span className="text-indigo-600 font-bold font-sans">설정치: {maxAboveGroundArea.toLocaleString()}㎡</span>
                <span>상한: 60k㎡</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Head-to-Head Comparison Grid with Current Active Alternative */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {portfolios.map((portfolio, idx) => {
          const isSelected = selectedIdx === idx;
          
          // 현재 활성 대안 대비 세대수 및 공급면적 격차 계산
          const defaultUnits = currentAlternative.types ? currentAlternative.types.reduce((sum, t) => sum + t.count, 0) : 0;
          const defaultSupplyArea = currentAlternative.types 
            ? currentAlternative.types.reduce((sum, t) => sum + (t.exclArea + t.commArea) * t.count, 0) 
            : 0;

          const unitDiff = portfolio.metrics.totalUnits - defaultUnits;
          const areaDiff = portfolio.metrics.totalSupplyArea - defaultSupplyArea;

          return (
            <div
              key={idx}
              onClick={() => setSelectedIdx(idx)}
              className={`p-3.5 border rounded transition-all cursor-pointer flex flex-col justify-between ${
                isSelected
                  ? "bg-slate-900 text-white border-slate-900 shadow-sm ring-1 ring-slate-800"
                  : "bg-white text-slate-800 border-slate-200 hover:border-slate-300"
              }`}
            >
              <div>
                {/* Badge section */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded uppercase ${
                      isSelected ? "bg-cyan-900 text-cyan-200" : "bg-cyan-50 text-cyan-800"
                     }`}>
                      {portfolio.badge}
                    </span>
                    <span className="font-bold text-xs">{portfolio.name}</span>
                  </div>

                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${
                    portfolio.metrics.isFeasible 
                      ? (isSelected ? "text-emerald-400 bg-emerald-950/40" : "text-emerald-600 bg-emerald-50")
                      : "text-rose-500 bg-rose-50"
                  }`}>
                    {portfolio.metrics.isFeasible ? "✓ 규동 안전성 충족" : "⚠️ 한계 타진"}
                  </span>
                </div>

                <p className={`text-[10px] leading-relaxed mb-3.5 ${isSelected ? "text-slate-350" : "text-slate-500"}`}>
                  {portfolio.description}
                </p>

                {/* Units distribution specs */}
                <div className="space-y-1 bg-slate-500/5 p-2 rounded mb-3.5 border border-slate-500/10">
                  <div className="text-[9.5px] font-semibold text-slate-400 mb-1">
                    🎯 제약 만족 도출 세대 믹스:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {portfolio.types.map((type, tIdx) => (
                      <span
                        key={tIdx}
                        className={`text-[9.5px] px-2 py-0.5 rounded font-bold font-mono ${
                          isSelected ? "bg-slate-800 text-yellow-400" : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {type.name}: <span className="text-[10px] font-sans">{type.count}</span>세대
                      </span>
                    ))}
                  </div>
                </div>

                {/* Comparison to Current Manual compose */}
                <div className="grid grid-cols-2 gap-2 text-[10px] mb-3.5">
                  <div className={`p-1.5 rounded ${isSelected ? "bg-slate-800/60" : "bg-slate-50"}`}>
                    <span className="block text-[9px] text-slate-400">기준대비 세대 공급 격차:</span>
                    <span className={`font-mono font-bold ${unitDiff >= 0 ? "text-green-500" : "text-amber-500"}`}>
                      {unitDiff >= 0 ? `+${unitDiff}` : `${unitDiff}`} 세대 {unitDiff >= 0 ? "증가" : "감소"}
                    </span>
                  </div>
                  <div className={`p-1.5 rounded ${isSelected ? "bg-slate-800/60" : "bg-slate-50"}`}>
                    <span className="block text-[9px] text-slate-400">예상 분양 가용 면적 격차:</span>
                    <span className={`font-mono font-bold ${areaDiff >= 0 ? "text-green-500" : "text-amber-500"}`}>
                      {areaDiff >= 0 ? `+${areaDiff.toFixed(1)}` : `${areaDiff.toFixed(1)}`} ㎡ {areaDiff >= 0 ? "확보" : "마진감축"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Action Buttons Container */}
              <div className="border-t pt-2.5 mt-2 border-slate-300/20 space-y-1.5">
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleApplyToCurrent(idx);
                    }}
                    className={`py-1.5 px-2 rounded font-bold flex items-center justify-center gap-1 text-[10px] transition-all cursor-pointer ${
                      isSelected
                        ? "bg-cyan-700 hover:bg-cyan-600 text-white"
                        : "bg-slate-100 hover:bg-slate-200 text-slate-800"
                    }`}
                    title="현재 켜진 대안의 타입을 이 AI 세대 비율로 전격 교체 덮어씁니다"
                  >
                    <Check className="w-3 h-3" /> 대안 덮어쓰기
                  </button>

                  <button
                    type="button"
                    disabled={!onAddAlternativeWithTypes}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCreateAsNewAlternative(idx);
                    }}
                    className={`py-1.5 px-2 rounded font-bold flex items-center justify-center gap-1 text-[10px] transition-all cursor-pointer text-slate-900 bg-amber-400 hover:bg-amber-300 disabled:bg-slate-300`}
                    title="이 추천 믹스를 원천으로 고유 대안을 하나 추가 복제하여 나란히 비교합니다"
                  >
                    <Plus className="w-3 h-3" /> 새 대안으로 복제 추가 (+)
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* AI Decision Advisory Section */}
      <div className="border border-indigo-100 bg-indigo-50/20 rounded p-3 text-[11px] mt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 font-bold text-slate-900">
            <Sparkles className="w-3.5 h-3.5 text-yellow-500" />
            <span>선택안 기반 하이브리드 조합 AI 분석 심의서 발행</span>
          </div>
          <button
            type="button"
            onClick={generateAiOptimizationReview}
            disabled={isAiLoading || portfolios.length === 0}
            className="px-3 py-1 bg-cyan-950 hover:bg-cyan-900 disabled:bg-slate-300 text-white text-[10px] font-bold rounded flex items-center gap-1 transition-colors cursor-pointer"
          >
            {isAiLoading ? "심의 의견 연산 중..." : "AI 디벨로퍼 분석 리포트 발행 요청"}
          </button>
        </div>

        {isAiLoading && (
          <div className="flex items-center gap-2 text-cyan-950/80 font-semibold p-4 justify-center bg-white/50 rounded">
            <div className="w-4 h-4 border-2 border-cyan-950 border-t-transparent rounded-full animate-spin"></div>
            <span>대한민국 상용 주차장 산정 조례와 비교하여 AI 투자 자문 총평을 초고속 라이팅 중입니다...</span>
          </div>
        )}

        {aiReport && (
          <div className="bg-white border border-slate-200 rounded p-3 pr-4 max-h-[220px] overflow-y-auto scrollbar-thin text-[11px] leading-relaxed text-slate-700 whitespace-pre-wrap font-sans mt-2">
            {aiReport}
          </div>
        )}
      </div>
    </div>
  );
};
