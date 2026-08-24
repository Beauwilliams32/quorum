"use client";

import { useEffect, useMemo, useState } from "react";

type Status = "Active" | "Ready" | "Blocked" | "External input";
type Project = { name:string; area:string; status:Status; progress:number; verification:string; next:string; blocker:string; accent:string };
type Runtime = { id:string; label:string; kind:string; available:boolean; authReady:boolean; capabilities:string[]; command?:string };
type Catalog = { runtimes:Runtime[]; models:{id:string;provider:string;kind:string;available:boolean;harnessId:string}[]; config:{projectCount:number;runtimeCount:number;modelCount:number}; pets:{subjectId:string;source:string}[] };

const projects: Project[] = [
  {name:"Project Atlas",area:"Product workspace",status:"Ready",progress:72,verification:"Checks and dry-run pass",next:"Provision the next integration",blocker:"Provider setup",accent:"violet"},
  {name:"Quorum Core",area:"Local system",status:"Active",progress:78,verification:"Tests and loopback health pass",next:"Finish installer validation",blocker:"Supported-platform proof",accent:"blue"},
  {name:"Operations Hub",area:"Product workspace",status:"Active",progress:68,verification:"Frontend and service checks pass",next:"Run one safe authenticated journey",blocker:"Verified platform connections",accent:"cyan"},
  {name:"Content Portal",area:"Product workspace",status:"Active",progress:82,verification:"Deployment-safety checks pass",next:"Complete browser smoke testing",blocker:"External service readiness",accent:"orange"},
  {name:"Beta Workspace",area:"Product workspace",status:"Blocked",progress:64,verification:"Dry-run and validation pass",next:"Run a role-separated beta",blocker:"Pilot access and compliance review",accent:"pink"},
  {name:"Automation Playbook",area:"Product workspace",status:"Active",progress:55,verification:"Readiness gate documented",next:"Verify confirmation and digest flow",blocker:"Sender and notification setup",accent:"green"},
  {name:"Creative Pipeline",area:"Internal beta",status:"Blocked",progress:61,verification:"Package and preflight pass",next:"Record a disposable host test",blocker:"Human review and distribution",accent:"yellow"},
  {name:"Tools Hub",area:"Product workspace",status:"Active",progress:63,verification:"Static surface established",next:"Browser-test export flows",blocker:"Custom-domain verification",accent:"blue"},
  {name:"Studio Hub",area:"Product workspace",status:"Active",progress:57,verification:"Portable handoff integrated",next:"Validate claims and public links",blocker:"Final launch decision",accent:"cyan"},
  {name:"Portfolio Workspace",area:"Local system",status:"Active",progress:59,verification:"Readiness wave integrated",next:"Audit storytelling and edit flow",blocker:"Approved content",accent:"orange"},
  {name:"Client Delivery",area:"Client implementation",status:"External input",progress:43,verification:"Deployment path documented",next:"Apply approved copy and assets",blocker:"Client assets and review",accent:"green"},
  {name:"Domain Migration",area:"Client implementation",status:"Blocked",progress:38,verification:"Phase one tested",next:"Verify ownership and redirects",blocker:"Domain-control review",accent:"red"},
  {name:"Data Migration",area:"Client implementation",status:"Blocked",progress:41,verification:"Validator documented",next:"Collect schedules and migration plan",blocker:"Client data access",accent:"red"},
  {name:"Memory Bridge",area:"Local system",status:"Active",progress:76,verification:"Tests and status checks pass",next:"Review observations explicitly",blocker:"Approved local source",accent:"violet"},
  {name:"Channel Operations",area:"Local system",status:"Blocked",progress:49,verification:"Readiness audit pass",next:"Create a rights-safe remediation plan",blocker:"Original or permissioned content",accent:"red"},
  {name:"Paper Trading Bot",area:"Local system",status:"Active",progress:71,verification:"Paper-mode checks pass",next:"Maintain observability",blocker:"Live trading out of scope",accent:"yellow"},
  {name:"Plugin Fleet",area:"Internal beta",status:"Blocked",progress:58,verification:"Bundles and tests pass",next:"Run human-controlled acceptance",blocker:"Host evidence and distribution",accent:"pink"},
];

const statusMeta: Record<Status,{label:string;className:string}> = {Active:{label:"Active",className:"active"},Ready:{label:"Ready to provision",className:"ready"},Blocked:{label:"Blocked",className:"blocked"},"External input":{label:"Needs input",className:"external"}};
const modelLibrary = [
  {name:"Claude",kind:"Cloud harness",source:"Anthropic CLI",pet:"vex",state:"Quorum-ready",detail:"Roundtable debate + local PTY"},
  {name:"Codex",kind:"Cloud harness",source:"OpenAI CLI",pet:"bolt",state:"Quorum-ready",detail:"Local project sessions"},
  {name:"Hermes",kind:"Local harness",source:"Loopback gateway",pet:"nib",state:"Detected",detail:"Background jobs + gateway health"},
  {name:"OpenClaw",kind:"Local harness",source:"Configurable runtime",pet:"sable",state:"Configurable",detail:"Add as a validated runtime"},
  {name:"Gemini",kind:"Cloud harness",source:"Configurable runtime",pet:"muse",state:"Configurable",detail:"BYO auth; never shown in UI"},
  {name:"ComfyUI / Wan",kind:"Local model engine",source:"Machine service",pet:"ledger",state:"Detected",detail:"Local media generation + pressure"},
];

export default function Home() {
  const [filter,setFilter] = useState<"All"|Status>("All");
  const [view,setView] = useState<"portfolio"|"operator">("portfolio");
  const [query,setQuery] = useState("");
  const [selected,setSelected] = useState<Project|null>(null);
  const [runtime,setRuntime] = useState({available:false, active:"—", rooms:"—", observed:"—"});
  const [catalog,setCatalog] = useState<Catalog|null>(null);
  const [roomId,setRoomId] = useState("");
  const [notice,setNotice] = useState("");
  useEffect(() => { fetch("/api/quorum").then((response) => response.json()).then((data) => { if (!data.available) return; const health = data.health ?? {}; const state = data.state ?? {}; const sessions = health.sessions ?? state.sessions ?? {}; const projectsState = health.projects ?? state.projects ?? state.projectRooms ?? {}; const rooms = state.projects?.rooms ?? []; setRoomId(String(rooms[0]?.id ?? "")); setRuntime({available:true, active:String(sessions.active ?? state.activeSessions ?? "live"), rooms:String(Array.isArray(projectsState) ? projectsState.length : projectsState.total ?? state.projectCount ?? "live"), observed:String(sessions.total ?? state.sessionCount ?? "live")}); if (data.catalog) setCatalog(data.catalog); }).catch(() => undefined); }, []);
  async function guardedLaunch(runtimeId:string) {
    if (!roomId) { setNotice("No Quorum project room is available for a guarded launch."); return; }
    setNotice(`Preparing a launch preview for ${runtimeId}…`);
    try { const response = await fetch("/api/quorum", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ action:"launch", runtimeId, roomId }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "preview failed"); if (!window.confirm(`${data.preview?.summary || "Launch runtime"}?`)) { setNotice("Launch cancelled."); return; } const confirmed = await fetch("/api/quorum", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ action:"launch", runtimeId, roomId, confirm:true }) }); const result = await confirmed.json(); setNotice(result.ok ? "Launch confirmed and recorded locally." : (result.error || "Launch was not executed.")); } catch (error) { setNotice(error instanceof Error ? error.message : "Quorum is offline; no launch was attempted."); }
  }
  const visible = useMemo(() => projects.filter((p) => { const haystack = `${p.name} ${p.area} ${p.next} ${p.blocker}`.toLowerCase(); return (filter === "All" || p.status === filter) && haystack.includes(query.toLowerCase()); }), [filter,query]);
  const blocked = projects.filter(p=>p.status === "Blocked").length;
  const active = projects.filter(p=>p.status === "Active" || p.status === "Ready").length;
  const avg = Math.round(projects.reduce((sum,p)=>sum+p.progress,0)/projects.length);

  return <main className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">✦</span><span>TRIDENT<br/><b>COMMAND</b></span></div><div className="side-label">Workspace</div><nav>
      <button className={`nav-item ${view === "portfolio" ? "selected" : ""}`} onClick={()=>setView("portfolio")}><span>◈</span> Portfolio overview</button>
      <button className={`nav-item ${view === "operator" ? "selected" : ""}`} onClick={()=>setView("operator")}><span>⌬</span> Operator cockpit</button>
      <button className="nav-item" onClick={()=>{setView("portfolio");setFilter("Blocked")}}><span>⊘</span> Needs attention <em>{blocked}</em></button>
      <button className="nav-item" onClick={()=>{setView("portfolio");setFilter("Active")}}><span>↗</span> In motion <em>{active}</em></button>
    </nav><div className="side-label">View</div><nav>
      <button className="nav-item" onClick={()=>setFilter("All")}><span>▦</span> All projects</button>
      <button className="nav-item" onClick={()=>setFilter("External input")}><span>◎</span> Client delivery</button>
      <button className="nav-item" onClick={()=>setFilter("Ready")}><span>◆</span> Ready next</button>
    </nav><div className="sidebar-foot"><span className="pulse-dot"/> Source synced<br/><small>Portfolio map · Aug 20, 2026</small></div></aside>
    <section className="content"><header className="topbar"><div className="crumb">STUDIO OS <span>/</span> PORTFOLIO</div><div className="top-actions"><span className="updated">Last reviewed · Aug 20, 2026</span><button className="avatar" aria-label="Account">BW</button></div></header>
      <div className="intro"><div><p className="eyebrow">Good morning, Beau <span>✦</span></p><h1>{view === "operator" ? "Run the room." : "Everything in motion."}</h1><p className="lede">{view === "operator" ? "Quorum convenes the argument. Unified AI Operator watches the local machine. Trident Command keeps the work, decisions, and handoffs in one operational picture." : "A live view of the work across Trident Studio—what is moving, what is verified, and where your attention unlocks the next step."}</p></div><button className="primary-btn" onClick={()=>view === "operator" ? setView("portfolio") : setFilter("All")}><span>{view === "operator" ? "↩" : "＋"}</span> {view === "operator" ? "Back to portfolio" : "Add project"}</button></div>
      <div className="metric-grid"><div className="metric-card hero-metric"><div className="metric-top"><span>Portfolio pulse</span><span className="metric-icon">↗</span></div><strong>{avg}%</strong><div className="metric-caption"><span className="trend">+8.4%</span> average readiness across {projects.length} projects</div><div className="sparkline">{Array.from({length:12},(_,i)=><i key={i}/>)}</div></div><div className="metric-card"><div className="metric-top"><span>In motion</span><span className="metric-icon green">◉</span></div><strong>{active}<small> / {projects.length}</small></strong><div className="metric-caption">Active or ready for the next gate</div><div className="mini-bar"><span style={{width:`${active/projects.length*100}%`}}/></div></div><div className="metric-card"><div className="metric-top"><span>Needs attention</span><span className="metric-icon red">!</span></div><strong>{blocked}<small> projects</small></strong><div className="metric-caption">Blocked by an external gate or risk</div><div className="attention-line"><span/> {projects.filter(p=>p.status === "Blocked").slice(0,3).map(p=>p.name.split(" ")[0]).join(" · ")}</div></div></div>
      {view === "portfolio" && <section className="project-landscape"><div className="section-head"><div><h2>Project landscape</h2><p>Readiness, verification, next move, and the gate holding each project.</p></div><div className="controls"><label className="search">⌕<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search projects"/></label><select value={filter} onChange={e=>setFilter(e.target.value as "All"|Status)}><option>All</option><option>Active</option><option>Ready</option><option>Blocked</option><option>External input</option></select></div></div><div className="project-list">{visible.map((project,index)=><button className="project-row" key={project.name} onClick={()=>setSelected(project)}><span className={`project-number ${project.accent}`}>{String(index+1).padStart(2,"0")}</span><span><span className="project-title">{project.name} <span className={`status ${statusMeta[project.status].className}`}><i/>{statusMeta[project.status].label}</span></span><span className="project-area">{project.area}</span></span><span className="project-next"><small>NEXT MOVE</small>{project.next}</span><span><span className="progress-label">{project.progress}%</span><span className="progress-track"><span className={`progress-fill ${project.accent}`} style={{width:`${project.progress}%`}}/></span></span><span className="row-arrow">→</span></button>)}</div></section>}
      {view === "operator" && <div className="model-library"><div className="library-head"><div><h2>Model + harness library</h2><p>Local catalog metadata only. Provider credentials and private prompts never cross this boundary.</p></div><span className="safe-note">{catalog ? `${catalog.runtimes.length} runtimes · ${catalog.models.length} models` : "offline fallback"}</span></div><div className="model-grid">{(catalog?.runtimes ?? modelLibrary.map(model => ({id:model.name.toLowerCase().replaceAll(" ","-"),label:model.name,kind:model.kind,available:model.state === "Detected",authReady:false,capabilities:[],command:model.name.toLowerCase()}))).map((model)=><div className="model-card" key={model.id}><div className={`pet-avatar ${model.id}`} aria-label={`${model.label} pet avatar`}><span className="pet-ear left"/><span className="pet-ear right"/><span className="pet-face"><i/><i/></span><span className="pet-nose"/></div><div className="model-copy"><div className="model-name">{model.label}<span className={`model-state ${model.available ? "detected" : ""}`}>{model.available ? "Ready" : "Offline"}</span></div><div className="model-kind">{model.kind} harness · {model.capabilities?.slice(0,2).join(" · ") || "safe adapter"}</div><div className="model-detail">{model.authReady ? "Existing local auth detected" : "Readiness only · auth stays local"}</div></div><button className="outline-btn model-launch" disabled={!model.available || !model.command} onClick={()=>guardedLaunch(model.id)}>Preview launch</button></div>)}</div>{notice && <p className="operator-notice">{notice}</p>}</div>}
      <footer className="footer"><span>TRIDENT STUDIO · PRIVATE WORKSPACE</span><span>Truthful status, clear next moves.</span></footer>
    </section>
    {selected&&<div className="modal-backdrop" onClick={()=>setSelected(null)}><article className="detail-modal" onClick={e=>e.stopPropagation()}><button className="close" onClick={()=>setSelected(null)} aria-label="Close">×</button><span className={`status ${statusMeta[selected.status].className}`}><i/>{statusMeta[selected.status].label}</span><h2>{selected.name}</h2><p className="modal-area">{selected.area}</p><div className="detail-progress"><span><b>{selected.progress}%</b> readiness</span><span className="progress-track"><span className={`progress-fill ${selected.accent}`} style={{width:`${selected.progress}%`}}/></span></div><div className="detail-block"><small>NEXT MOVE</small><p>{selected.next}</p></div><div className="detail-block warning"><small>GATE / BLOCKER</small><p>{selected.blocker}</p></div><div className="detail-block"><small>VERIFICATION</small><p>{selected.verification}</p></div></article></div>}
  </main>;
}
