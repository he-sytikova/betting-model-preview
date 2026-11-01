(() => {
  const $ = id => document.getElementById(id);
  const norm = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\b(fc|afc|cf|sc|sv|fk|sk|club|the)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  function meanPrediction(model, values) {
    const z = model.features.map((name, i) => {
      const raw = values[name];
      const v = Number.isFinite(raw) ? raw : model.imputerMedian[i];
      return (v - model.scalerMean[i]) / (model.scalerScale[i] || 1);
    });
    const eta = model.intercept + z.reduce((a, v, i) => a + v * model.coefficients[i], 0);
    return Math.max(.05, Math.min(8, Math.exp(Math.max(-5, Math.min(5, eta)))));
  }
  function pmf(lambda, max) {
    const p = [Math.exp(-lambda)];
    for (let i=1;i<=max;i++) p.push(p[i-1] * lambda / i);
    const sum = p.reduce((a,b)=>a+b,0);
    return p.map(x=>x/sum);
  }
  function scoreMarkets(homeMean, awayMean) {
    const max = 12, hp = pmf(homeMean,max), ap = pmf(awayMean,max);
    const cells = [];
    let total = 0, home=0, draw=0, away=0, btts=0;
    const totals = [0.5,1.5,2.5,3.5,4.5,5.5].map(line=>({line,over:0}));
    const homeTotals = [0.5,1.5,2.5].map(line=>({line,over:0}));
    const awayTotals = [0.5,1.5,2.5].map(line=>({line,over:0}));
    const handicaps = [-1.5,-0.5,0.5,1.5].map(line=>({line,win:0}));
    for(let h=0;h<=max;h++) for(let a=0;a<=max;a++){
      const p=hp[h]*ap[a]; total+=p; cells.push({h,a,p});
      if(h>a) home+=p; else if(h===a) draw+=p; else away+=p;
      if(h>0&&a>0) btts+=p;
      for(const x of totals) if(h+a>x.line) x.over+=p;
      for(const x of homeTotals) if(h>x.line) x.over+=p;
      for(const x of awayTotals) if(a>x.line) x.over+=p;
      for(const x of handicaps) if(h-a+x.line>0) x.win+=p;
    }
    const pct=x=>(100*x/total).toFixed(1)+"%";
    const top=cells.sort((x,y)=>y.p-x.p).slice(0,3).map(x=>x.h+":"+x.a+" "+pct(x.p)).join(" · ");
    return {
      outcome:"П1 "+pct(home)+" / X "+pct(draw)+" / П2 "+pct(away),
      doubleChance:"1X "+pct(home+draw)+" / 12 "+pct(home+away)+" / X2 "+pct(draw+away),
      totals:totals.map(x=>"ТБ"+x.line+" "+pct(x.over)+" / ТМ "+pct(total-x.over)).join("\n"),
      btts:"Да "+pct(btts)+" / Нет "+pct(total-btts),
      teamTotals:"Х: "+homeTotals.map(x=>x.line+"+ "+pct(x.over)).join(" · ")+"\nГ: "+awayTotals.map(x=>x.line+"+ "+pct(x.over)).join(" · "),
      correct:top,
      handicap:handicaps.map(x=>(x.line>0?"+":"")+x.line+" "+pct(x.win)).join(" · ")
    };
  }
  function findTeam(league, name) {
    const teams = goalModel.teams?.[league] || {};
    const target = norm(name);
    const matches = Object.entries(teams).filter(([key,v])=>norm(key)===target||norm(v.name)===target);
    return matches.length===1 ? matches[0][1] : null;
  }
  let goalModel = null;
  async function loadGoalMarkets(){
    const status=$("goals-model-status"), body=$("goals-markets-body");
    if(!status||!body) return;
    try{
      const [dataResponse,modelResponse]=await Promise.all([
        fetch("./data.json?t="+Date.now(),{cache:"no-store"}),
        fetch("./data/goals_markets_models.json?t="+Date.now(),{cache:"no-store"})
      ]);
      if(!dataResponse.ok||!modelResponse.ok) throw new Error("Модель голов ещё не опубликована из ветки model-development.");
      const data=await dataResponse.json(); goalModel=await modelResponse.json();
      if(goalModel.status!=="experimental_research_model"||!goalModel.teams||!goalModel.models) throw new Error("Некорректный экспорт модели голов.");
      const aliases=new Map(Object.entries(goalModel.leagueAliases||{}).map(([k,v])=>[norm(k),v]));
      for(const [code,name] of Object.entries(goalModel.leagueNames||{})) aliases.set(norm(name),code);
      const fixtures=(data.predictions||[]).filter(x=>Date.parse(x.time)>Date.now());
      const rows=[];
      for(const f of fixtures){
        const league=aliases.get(norm(f.league));
        if(!league) continue;
        const home=findTeam(league,f.home), away=findTeam(league,f.away), leagueStats=goalModel.leagueStats?.[league];
        if(!home||!away||!leagueStats) continue;
        const values={};
        for(const feature of goalModel.features){
          const side=feature.startsWith("home_")?"home":"away";
          const key=feature.slice(side.length+1);
          values[feature]=(side==="home"?home:away).stats?.[key];
        }
        for(const [k,v] of Object.entries(leagueStats)) values[k]=v;
        values.home_advantage=1;
        const hm=meanPrediction(goalModel.models.homeGoals,values);
        const am=meanPrediction(goalModel.models.awayGoals,values);
        rows.push({time:f.time,league:f.league,home:f.home,away:f.away,hm,am,...scoreMarkets(hm,am)});
      }
      rows.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
      body.replaceChildren();
      for(const x of rows){
        const tr=document.createElement("tr");
        const vals=[new Date(x.time).toLocaleString("ru-RU",{timeZone:"Europe/Moscow",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}),x.league,x.home,x.away,x.outcome,x.doubleChance,x.totals,x.btts,x.teamTotals,x.correct,x.handicap,"λ "+x.hm.toFixed(2)+" / "+x.am.toFixed(2)];
        for(const value of vals){const td=document.createElement("td");td.textContent=value;td.style.whiteSpace="pre-line";tr.appendChild(td);}
        body.appendChild(tr);
      }
      status.textContent="Самостоятельная модель голов: "+rows.length+" предстоящих матчей · обучено на "+goalModel.trainingRows+" исторических матчах · до "+goalModel.trainingThrough;
      $("goals-markets-empty").classList.toggle("hidden",rows.length>0);
    }catch(e){status.textContent=e.message;$("goals-markets-empty").classList.remove("hidden");}
  }
  document.addEventListener("DOMContentLoaded",loadGoalMarkets);
})();