// @ts-nocheck
/**
 * Markdown Wiki — 1:1 port of the Claude Design "Markdown wiki platform".
 *
 * The logic below is the design component logic, carried over unchanged: it already
 * mirrors React.Component (state / setState / componentDid*). Only the React.Component
 * base class and render() (the design template translated to JSX) are new. All data is
 * in-file mock content — no DB/API wiring yet (that is the next, integration phase).
 *
 * Helpers: sx() turns the design’s CSS-string styles into React style objects; <Hov>
 * reproduces its style-hover behaviour. See ./dc.
 */
import React from "react"
import { Hov, sx } from "./dc"
import "./wiki.css"

/** Ref callback: scroll the keyboard-selected menu row into view (no page jump). */
function scrollIntoNearest(el) {
  if (el) el.scrollIntoView({ block: 'nearest' })
}

export default class MarkdownWiki extends React.Component {

  state = {
    theme: 'light',
    activeId: 'second-brain',
    layout: 'three',
    expanded: { 'f-daily': true, 'f-projects': true, 'f-concepts': true, 'f-sources': false },
    palette: { open: false, q: '' },
    paletteIdx: 0,
    graph: { open: false, hover: null },
    graphMode: 'global',
    linkMenu: { open: false, q: '', idx: 0, left: 0, top: 0, maxH: 0 },
    slashMenu: { open: false, q: '', idx: 0, left: 0, top: 0, maxH: 0 },
    selBar: { open: false, left: 0, top: 0, fmt: {}, blockType: 'p', blockOpen: false },
    preview: { open: false, id: null, left: 0, top: 0 },
    mentionsTab: 'linked',
    project: 'atlas',
    projectMenu: false,
    md: '',
    mdCopied: false,
    outline: [],
    words: 0,
    saved: 'Saved',
  };

  S = {
    p: "font:400 17.5px/1.74 'Spectral',serif;color:var(--ink-soft);margin:0 0 18px;",
    h1: "font:600 27px/1.24 'Spectral',serif;color:var(--ink);margin:26px 0 10px;letter-spacing:-.013em;",
    h2: "font:600 21px/1.3 'Spectral',serif;color:var(--ink);margin:32px 0 11px;letter-spacing:-.01em;",
    h3: "font:600 16.5px/1.32 'Spectral',serif;color:var(--ink);margin:22px 0 8px;",
    li: "font:400 17.5px/1.66 'Spectral',serif;color:var(--ink-soft);margin:0 0 7px;",
    ul: "margin:0 0 18px;padding-left:23px;",
    task: "font:400 17px/1.6 'Spectral',serif;color:var(--ink-soft);margin:0 0 7px;display:flex;align-items:flex-start;gap:10px;",
    hr: "border:none;border-top:1px solid var(--border);margin:24px 0;",
    quote: "margin:0 0 18px;padding:5px 0 5px 20px;border-left:3px solid var(--accent);color:var(--ink);font:italic 400 18px/1.62 'Spectral',serif;",
    code: "font:500 13.5px/1.65 'IBM Plex Mono',monospace;background:var(--code-bg);border:1px solid var(--border);border-radius:9px;padding:13px 15px;color:var(--ink-soft);margin:0 0 18px;white-space:pre-wrap;display:block;overflow:auto;",
    ic: "font:500 13.5px 'IBM Plex Mono',monospace;background:var(--code-bg);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--ink);",
    callout: "margin:0 0 18px;border:1px solid var(--border);background:var(--accent-soft);border-radius:11px;padding:13px 16px;",
    cT: "font:600 11px/1 'IBM Plex Mono',monospace;letter-spacing:.09em;text-transform:uppercase;color:var(--accent-ink);margin:0 0 6px;",
    cP: "font:400 16px/1.6 'Spectral',serif;color:var(--ink-soft);margin:0;",
  };

  LIGHT = { '--bg':'#e7dfcf','--panel':'#efe8da','--surface':'#faf6ee','--ink':'#2c2823','--ink-soft':'#4f4a40','--muted':'#9a917f','--border':'#dcd3c0','--accent':'#6a7cff','--accent-ink':'#4b53c6','--accent-soft':'rgba(106,124,255,0.15)','--link':'#4b53c6','--code-bg':'#efe8d9' };
  DARK = { '--bg':'#121317','--panel':'#17181d','--surface':'#1a1b21','--ink':'#e8e4d9','--ink-soft':'#bdb8aa','--muted':'#827c6f','--border':'#2a2b33','--accent':'#7c8cff','--accent-ink':'#9aa3ff','--accent-soft':'rgba(124,140,255,0.16)','--link':'#9aa3ff','--code-bg':'#0f1014' };

  notes = [
    { id:'second-brain', title:'Second Brain', folder:'f-concepts', type:'concept', status:'evergreen', planted:'2025-11-02', updated:'2026-06-26', tags:['pkm','method','evergreen'], excerpt:'An external, trusted system for the ideas you don\u2019t want to lose.' },
    { id:'compounding', title:'Compounding', folder:'f-concepts', type:'concept', status:'evergreen', planted:'2025-09-18', updated:'2026-06-21', tags:['mental-model','growth'], excerpt:'Small linked observations quietly accrue into understanding.' },
    { id:'antifragility', title:'Antifragility', folder:'f-concepts', type:'concept', status:'budding', planted:'2026-01-12', updated:'2026-05-30', tags:['mental-model','risk'], excerpt:'Some systems gain from disorder rather than merely surviving it.' },
    { id:'network-effects', title:'Network Effects', folder:'f-concepts', type:'concept', status:'budding', planted:'2026-02-04', updated:'2026-06-12', tags:['economics','systems'], excerpt:'Value rises with each new node \u2014 and so does fragility.' },
    { id:'spaced-repetition', title:'Spaced Repetition', folder:'f-concepts', type:'concept', status:'evergreen', planted:'2025-10-07', updated:'2026-06-18', tags:['learning','method'], excerpt:'Review on a widening schedule, just before you would forget.' },
    { id:'serendipity', title:'Serendipity', folder:'f-concepts', type:'concept', status:'seedling', planted:'2026-06-09', updated:'2026-06-24', tags:['creativity'], excerpt:'Arrive looking for one thing; leave with three.' },
    { id:'markdown-wiki', title:'Markdown Wiki', folder:'f-projects', type:'project', status:'draft', planted:'2026-06-01', updated:'2026-06-26', tags:['project','tools'], excerpt:'A project-based, linkable home for everything I know.' },
    { id:'reading-habit', title:'Reading Habit System', folder:'f-projects', type:'project', status:'budding', planted:'2026-03-21', updated:'2026-06-20', tags:['project','habits'], excerpt:'Turn reading from intention into an automatic loop.' },
    { id:'thinking-in-systems', title:'Thinking in Systems', folder:'f-sources', type:'source', status:'evergreen', planted:'2025-12-15', updated:'2026-04-02', tags:['book','systems'], excerpt:'Donella Meadows \u2014 stocks, flows, and where to intervene.' },
    { id:'beginning-of-infinity', title:'The Beginning of Infinity', folder:'f-sources', type:'source', status:'budding', planted:'2026-01-29', updated:'2026-05-11', tags:['book','epistemology'], excerpt:'David Deutsch \u2014 good explanations are hard to vary.' },
    { id:'d-0626', title:'2026-06-26', folder:'f-daily', type:'daily', status:'daily', planted:'2026-06-26', updated:'2026-06-26', tags:['daily'], excerpt:'Wired up backlinks; the vault is starting to feel alive.' },
    { id:'d-0624', title:'2026-06-24', folder:'f-daily', type:'daily', status:'daily', planted:'2026-06-24', updated:'2026-06-24', tags:['daily'], excerpt:'A walk knocked two ideas together. Noted before they faded.' },
    { id:'inbox', title:'Inbox', folder:null, type:'inbox', status:'seedling', planted:'2026-06-25', updated:'2026-06-26', tags:['fleeting'], excerpt:'Unsorted captures waiting for a home.' },
  ];

  tree = [
    { type:'folder', id:'f-daily', name:'Daily', children:['d-0626','d-0624'] },
    { type:'folder', id:'f-projects', name:'Projects', children:['markdown-wiki','reading-habit'] },
    { type:'folder', id:'f-concepts', name:'Concepts', children:['second-brain','compounding','antifragility','network-effects','spaced-repetition','serendipity'] },
    { type:'folder', id:'f-sources', name:'Sources', children:['thinking-in-systems','beginning-of-infinity'] },
    { type:'note', id:'inbox' },
  ];

  edges = [
    ['second-brain','compounding'],['second-brain','spaced-repetition'],['second-brain','network-effects'],['second-brain','serendipity'],['second-brain','markdown-wiki'],
    ['compounding','antifragility'],['compounding','network-effects'],['compounding','second-brain'],
    ['antifragility','thinking-in-systems'],
    ['network-effects','serendipity'],['network-effects','beginning-of-infinity'],
    ['spaced-repetition','reading-habit'],['spaced-repetition','second-brain'],
    ['serendipity','beginning-of-infinity'],
    ['markdown-wiki','second-brain'],['markdown-wiki','spaced-repetition'],
    ['reading-habit','thinking-in-systems'],
    ['thinking-in-systems','network-effects'],
    ['beginning-of-infinity','network-effects'],
    ['d-0626','second-brain'],['d-0626','markdown-wiki'],['d-0626','reading-habit'],
    ['d-0624','compounding'],['d-0624','beginning-of-infinity'],
    ['inbox','serendipity'],
  ];

  bodies = {};
  _defaults = null;

  projects = [
    { id:'atlas', name:'Atlas', glyph:'A', tint:'var(--accent)', desc:'Personal second brain' },
    { id:'reading-room', name:'Reading Room', glyph:'R', tint:'#5fb3a3', desc:'Books, quotes & marginalia' },
    { id:'field-notes', name:'Field Notes', glyph:'F', tint:'#c98a6a', desc:'Fleeting captures & daily log' },
  ];

  // ---------- projects / vaults ----------
  toggleProjectMenu(){ this.setState(s=>({ projectMenu:!s.projectMenu })); }
  closeProjectMenu(){ this.setState({ projectMenu:false }); }
  initVaults(){ if(this._vaults) return; this._vaults={}; this._vaults['atlas']={ notes:this.notes, tree:this.tree, edges:this.edges, bodies:this.bodies, defaults:(this._defaults||this.buildAtlasDefaults()), home:'second-brain' }; this._defaults=this._vaults['atlas'].defaults; this.activeVault='atlas'; }
  loadVault(id){ if(this.activeVault && this._vaults[this.activeVault]){ const cur=this._vaults[this.activeVault]; cur.notes=this.notes; cur.tree=this.tree; cur.edges=this.edges; cur.bodies=this.bodies; } if(!this._vaults[id]) this._vaults[id]=this.buildVault(id); const v=this._vaults[id]; this.notes=v.notes; this.tree=v.tree; this.edges=v.edges; this.bodies=v.bodies; this._defaults=v.defaults; this._layout=null; this.activeVault=id; }
  defaultExpandedFor(id){ const v=this._vaults[id]||this.buildVault(id); const e={}; v.tree.forEach(t=>{ if(t.type==='folder') e[t.id]=true; }); return e; }
  switchProject(id){ if(id===this.state.project){ this.setState({projectMenu:false}); return; } this.loadVault(id); const home=this._vaults[id].home; const exp=this.defaultExpandedFor(id); this._loadedId=null; this.setState({ project:id, projectMenu:false, graph:{open:false,hover:null}, graphMode:'global', palette:{open:false,q:''}, linkMenu:{open:false,q:'',idx:0,left:0,top:0}, slashMenu:{open:false,q:'',idx:0,left:0,top:0}, selBar:{open:false,left:0,top:0}, preview:{open:false,id:null,left:0,top:0}, expanded:exp }); this.openNote(home); }
  newProject(){ const id='vault-'+Date.now(); const tints=['#7c8cff','#5fb3a3','#c98a6a','#6f9bd1','#b07bd1','#cf7d9e']; this.projects.push({ id, name:'New Project', glyph:'\u2726', tint:tints[this.projects.length%tints.length], desc:'Empty vault \u2014 start writing' }); this._vaults[id]={ notes:[{id:'untitled',title:'Untitled',folder:null,type:'concept',status:'seedling',planted:'2026-06-27',updated:'2026-06-27',tags:['fleeting'],excerpt:'A fresh, empty note.'}], tree:[{type:'note',id:'untitled'}], edges:[], bodies:{}, defaults:{}, home:'untitled' }; this.switchProject(id); }
  buildVault(id){ const S=this.S; const localWl=(ns)=>{ const m={}; ns.forEach(n=>m[n.id]=n.title); return (x)=>this.wlWith(x, m[x]||this.titleize(x)); };
    if(id==='reading-room'){
      const notes=[
        { id:'rr-shelf', title:'The Shelf', folder:'rr-f-index', type:'concept', status:'evergreen', planted:'2025-08-01', updated:'2026-06-25', tags:['index'], excerpt:'Everything currently in rotation, and why.' },
        { id:'rr-deep-work', title:'Deep Work', folder:'rr-f-books', type:'source', status:'evergreen', planted:'2025-09-10', updated:'2026-05-20', tags:['book','focus'], excerpt:'Cal Newport \u2014 focus as a competitive superpower.' },
        { id:'rr-range', title:'Range', folder:'rr-f-books', type:'source', status:'budding', planted:'2026-02-12', updated:'2026-06-10', tags:['book','generalist'], excerpt:'David Epstein \u2014 why generalists triumph in a specialised world.' },
        { id:'rr-annotation', title:'Annotation', folder:'rr-f-notes', type:'concept', status:'budding', planted:'2026-03-02', updated:'2026-06-18', tags:['method'], excerpt:'Reading with a pen is a conversation, not consumption.' },
        { id:'rr-rereading', title:'On Rereading', folder:'rr-f-notes', type:'concept', status:'seedling', planted:'2026-06-08', updated:'2026-06-22', tags:['method'], excerpt:'The book does not change; you do.' },
      ];
      const wl=localWl(notes);
      const tree=[
        { type:'folder', id:'rr-f-index', name:'Index', children:['rr-shelf'] },
        { type:'folder', id:'rr-f-books', name:'Books', children:['rr-deep-work','rr-range'] },
        { type:'folder', id:'rr-f-notes', name:'Reading notes', children:['rr-annotation','rr-rereading'] },
      ];
      const edges=[ ['rr-shelf','rr-deep-work'],['rr-shelf','rr-range'],['rr-shelf','rr-annotation'],['rr-deep-work','rr-annotation'],['rr-range','rr-rereading'],['rr-annotation','rr-rereading'],['rr-range','rr-deep-work'] ];
      const defaults={
        'rr-shelf':`<p style="${S.p}">The books in active rotation, and the notes growing out of them. Start here, then follow a thread wherever it pulls.</p><ul style="${S.ul}"><li style="${S.li}">${wl('rr-deep-work')} \u2014 on focus and its discontents.</li><li style="${S.li}">${wl('rr-range')} \u2014 the quiet case for breadth.</li></ul><p style="${S.p}">All of it read with a pen \u2014 see ${wl('rr-annotation')}.</p>`,
        'rr-deep-work':`<p style="${S.p}"><em>Cal Newport.</em> The ability to focus without distraction is becoming rare at exactly the moment it is becoming valuable. Practised attention compounds.</p><blockquote style="${S.quote}">Clarity about what matters provides clarity about what does not.</blockquote><p style="${S.p}">Best read slowly, pen in hand \u2014 see ${wl('rr-annotation')}.</p>`,
        'rr-range':`<p style="${S.p}"><em>David Epstein.</em> In kind, slow-feedback domains, breadth of experience beats early specialisation. Sampling widely is not wasted time \u2014 it is the search.</p><p style="${S.p}">Worth ${wl('rr-rereading')} after a year away.</p>`,
        'rr-annotation':`<p style="${S.p}">Annotation turns reading from consumption into conversation. The margin is where the book talks back, and where ${wl('rr-deep-work')} actually happens.</p><ul style="${S.ul}"><li style="${S.li}">Mark the turns in the argument, not the pretty sentences.</li><li style="${S.li}">Write the objection you would raise out loud.</li></ul>`,
        'rr-rereading':`<p style="${S.p}">A book reread is a different book, because you are a different reader. ${wl('rr-range')} rewards the second pass especially \u2014 the breadth lands only once you have the depth to miss it.</p>`,
      };
      return { notes, tree, edges, bodies:{}, defaults, home:'rr-shelf' };
    }
    if(id==='field-notes'){
      const notes=[
        { id:'fn-today', title:'Today', folder:'fn-f-log', type:'daily', status:'daily', planted:'2026-06-27', updated:'2026-06-27', tags:['daily'], excerpt:'What caught the eye today.' },
        { id:'fn-attention', title:'Attention', folder:'fn-f-threads', type:'concept', status:'budding', planted:'2026-04-04', updated:'2026-06-19', tags:['thread'], excerpt:'What you attend to is what you slowly become.' },
        { id:'fn-walking', title:'Walking & Thinking', folder:'fn-f-threads', type:'concept', status:'budding', planted:'2026-03-15', updated:'2026-06-11', tags:['thread'], excerpt:'The pace of thought tends to match the pace of feet.' },
        { id:'fn-margins', title:'Marginalia', folder:'fn-f-threads', type:'concept', status:'seedling', planted:'2026-06-05', updated:'2026-06-20', tags:['thread'], excerpt:'Small notes in small spaces, oddly durable.' },
        { id:'fn-questions', title:'Open Questions', folder:'fn-f-log', type:'inbox', status:'seedling', planted:'2026-06-02', updated:'2026-06-26', tags:['fleeting'], excerpt:'Things I do not yet know how to ask.' },
      ];
      const wl=localWl(notes);
      const tree=[
        { type:'folder', id:'fn-f-log', name:'Log', children:['fn-today','fn-questions'] },
        { type:'folder', id:'fn-f-threads', name:'Threads', children:['fn-attention','fn-walking','fn-margins'] },
      ];
      const edges=[ ['fn-today','fn-attention'],['fn-today','fn-walking'],['fn-attention','fn-walking'],['fn-walking','fn-margins'],['fn-questions','fn-attention'],['fn-margins','fn-today'] ];
      const defaults={
        'fn-today':`<p style="${S.p}">A clear morning. Two things worth keeping before they evaporate.</p><ul style="${S.ul}"><li style="${S.li}">${wl('fn-walking')} again \u2014 the third mile is where the knot loosens.</li><li style="${S.li}">Reread an old note on ${wl('fn-attention')} and disagreed with myself. A good sign.</li></ul>`,
        'fn-attention':`<p style="${S.p}">Attention is the rarest and purest form of generosity. What you attend to, repeatedly, is what you slowly become \u2014 so it is worth choosing.</p><blockquote style="${S.quote}">The things you notice are choosing you as much as you are choosing them.</blockquote><p style="${S.p}">Feeds directly into ${wl('fn-walking')}.</p>`,
        'fn-walking':`<p style="${S.p}">Thinking improves at roughly three miles an hour. The body sets a tempo the mind can follow, and ${wl('fn-attention')} widens on the move.</p>`,
        'fn-margins':`<p style="${S.p}">The smallest notes, written in the smallest spaces, often outlast the essays around them. Collected back into ${wl('fn-today')} when they prove they have legs.</p>`,
        'fn-questions':`<p style="${S.p}">Questions I cannot yet phrase cleanly. Holding them loosely.</p><ul style="${S.ul}"><li style="${S.li}">Is ${wl('fn-attention')} trainable, or only ever redirectable?</li><li style="${S.li}">What would a genuinely slow internet feel like?</li></ul>`,
      };
      return { notes, tree, edges, bodies:{}, defaults, home:'fn-today' };
    }
    return { notes:[{id:'untitled',title:'Untitled',folder:null,type:'concept',status:'seedling',planted:'2026-06-27',updated:'2026-06-27',tags:['fleeting'],excerpt:'A fresh, empty note.'}], tree:[{type:'note',id:'untitled'}], edges:[], bodies:{}, defaults:{}, home:'untitled' };
  }

  // ---------- helpers ----------
  note(id){ return this.notes.find(n => n.id === id) || { id, title: this.titleize(id), type:'concept', status:'seedling', planted:'\u2014', updated:'\u2014', tags:[], excerpt:'' }; }
  title(id){ return this.note(id).title; }
  titleize(id){ return id.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase()); }
  allIds(){ return this.notes.map(n => n.id); }
  wlWith(id, title){ return `<span class="wl" data-link="${id}" contenteditable="false" style="color:var(--link);font-family:'IBM Plex Sans',sans-serif;font-weight:500;font-size:.93em;border-bottom:1px solid color-mix(in srgb, var(--link) 32%, transparent);padding-bottom:.5px;white-space:nowrap;">${title}</span>`; }
  wl(id){ return this.wlWith(id, this.title(id)); }

  buildAtlasDefaults(){
    const S = this.S, wl = id => this.wl(id);
    const d = {};
    d['second-brain'] = `
<p style="${S.p}">A <em>second brain</em> is an external, trusted system for the ideas you don\u2019t want to lose \u2014 a place to capture, connect, and grow what you know across years rather than days. The promise isn\u2019t more notes; it\u2019s ${wl('compounding')}: small, linked observations that quietly accrue into understanding.</p>
<div style="${S.callout}"><div style="${S.cT}">\u25c6 &nbsp;Principle</div><p style="${S.cP}">Notes are not a filing cabinet. They are a conversation with your future self, conducted in links.</p></div>
<h2 style="${S.h2}">Why link, not file</h2>
<p style="${S.p}">Folders force a single home for each idea. But ideas belong in many places at once. Linking lets a note on ${wl('spaced-repetition')} sit beside your reading log, your project notes, and a half-formed theory of ${wl('network-effects')} \u2014 without choosing one parent.</p>
<ul style="${S.ul}"><li style="${S.li}">Capture in your own words; a quote you can\u2019t paraphrase isn\u2019t yet understood.</li><li style="${S.li}">Link generously \u2014 every <span style="${S.ic}">[[wikilink]]</span> is a future path back.</li><li style="${S.li}">Let structure <em>emerge</em> from links, not from the folder you guessed at on day one.</li></ul>
<blockquote style="${S.quote}">\u201cWe do not learn from experience\u2026 we learn from reflecting on experience.\u201d \u2014 and reflection needs somewhere to live.</blockquote>
<h2 style="${S.h2}">The compounding loop</h2>
<p style="${S.p}">Each pass over an old note is a chance to revise, merge, or split it. Over time the system develops a kind of ${wl('serendipity')}: you arrive looking for one thing and leave with three. That surprise is the point \u2014 and it\u2019s why this connects to the ${wl('markdown-wiki')} I\u2019m building.</p>
<pre style="${S.code}">type:    concept
status:  evergreen
planted: 2025-11-02
links:   6 out \u00b7 4 in</pre>`;
    d['compounding'] = `
<p style="${S.p}">Compounding is the quiet engine behind almost everything that grows: capital, skill, relationships, and notes. Each increment builds on the last, so the curve that looks flat for a long while turns suddenly steep.</p>
<p style="${S.p}">In a knowledge system the unit that compounds is the <em>link</em>. A note connected to ten others is worth far more than ten times an isolated one \u2014 it shares the logic of ${wl('network-effects')}, and it is what makes a ${wl('second-brain')} more than a folder of orphans.</p>
<blockquote style="${S.quote}">The first rule of compounding: never interrupt it unnecessarily.</blockquote>
<p style="${S.p}">Related: ${wl('antifragility')} \u2014 because the systems that compound longest are the ones that survive their own volatility.</p>`;
    d['antifragility'] = `
<p style="${S.p}">Coined by Nassim Taleb, <em>antifragility</em> names what has no word: not the opposite of fragile (that is merely robust) but things that <em>gain</em> from disorder, stress, and volatility.</p>
<div style="${S.callout}"><div style="${S.cT}">\u25c6 &nbsp;Distinction</div><p style="${S.cP}">Fragile breaks under shock. Robust resists it. Antifragile improves because of it.</p></div>
<p style="${S.p}">A reading practice that gets sharper when challenged is antifragile. So is a note that grows clearer every time you fail to explain it. See ${wl('thinking-in-systems')} for the structural view of why this happens.</p>
<p style="${S.p}">A second brain only earns its keep when it can take a hit and come back clearer — antifragile knowledge, not just stored knowledge.</p>`;
    d['network-effects'] = `
<p style="${S.p}">A network effect occurs when each new participant makes the whole more valuable to everyone already in it. Telephones, languages, marketplaces \u2014 and, at smaller scale, a densely linked set of notes.</p>
<p style="${S.p}">The same property that creates value creates fragility: highly connected hubs are powerful and dangerous. This tension links directly to ${wl('serendipity')} and to ${wl('beginning-of-infinity')}.</p>`;
    d['spaced-repetition'] = `
<p style="${S.p}">Spaced repetition schedules review at widening intervals \u2014 right before you would have forgotten. It trades a little effort now for durable memory later, which is its own kind of ${wl('compounding')}.</p>
<ul style="${S.ul}"><li style="${S.li}">Recall actively; recognition is a comfortable lie.</li><li style="${S.li}">Space the reviews; massed practice fades fast.</li><li style="${S.li}">Connect each card to a note in your ${wl('second-brain')}.</li></ul>
<p style="${S.p}">This is the backbone of my ${wl('reading-habit')}.</p>`;
    d['serendipity'] = `
<p style="${S.p}">Serendipity is not luck; it is prepared attention meeting surface area. A linked vault manufactures it: you open one note and three unexpected neighbours are already there, waiting.</p>
<p style="${S.p}">It feeds on ${wl('network-effects')} and rewards the patient reader of ${wl('beginning-of-infinity')}.</p>`;
    d['markdown-wiki'] = `
<p style="${S.p}">A project-based markdown wiki: folders and notes on the left, the living document in the centre, metadata and backlinks on the right, and a ${wl('second-brain')} worth of links holding it together.</p>
<div style="${S.callout}"><div style="${S.cT}">\u25c6 &nbsp;Design goals</div><p style="${S.cP}">Plain text forever. Linking as a first-class verb. Structure that emerges, never imposed.</p></div>
<h2 style="${S.h2}">Open questions</h2>
<ul style="${S.ul}"><li style="${S.li}">How heavy should the graph be \u2014 ambient, or a destination?</li><li style="${S.li}">Inline ${wl('spaced-repetition')} prompts, or a separate review mode?</li></ul>
<pre style="${S.code}">status:  draft
planted: 2026-06-01
stack:   plain markdown + links</pre>`;
    d['reading-habit'] = `
<p style="${S.p}">A system to turn reading from intention into an automatic loop: capture \u2192 distil \u2192 link \u2192 review. The distil and review steps lean on ${wl('spaced-repetition')}.</p>
<p style="${S.p}">Currently reading: ${wl('thinking-in-systems')}.</p>`;
    d['thinking-in-systems'] = `
<p style="${S.p}"><em>Donella Meadows.</em> The clearest short book on stocks, flows, feedback, and leverage points \u2014 the places in a system where a small shift changes everything.</p>
<blockquote style="${S.quote}">The least obvious leverage points have the most power, and we almost always push them the wrong way.</blockquote>
<p style="${S.p}">Reframes ${wl('network-effects')} as feedback structure rather than mere connection.</p>`;
    d['beginning-of-infinity'] = `
<p style="${S.p}"><em>David Deutsch.</em> Knowledge grows through good explanations \u2014 ones that are hard to vary without breaking. An argument for unbounded progress, grounded in epistemology.</p>
<p style="${S.p}">Pairs with ${wl('network-effects')} when you ask how explanations actually spread. A second brain is, in miniature, an engine for exactly this kind of error-correction.</p>`;
    d['d-0626'] = `
<p style="${S.p}"><strong>Morning.</strong> Wired up backlinks and the local graph. Watching a note light up with its mentions is oddly motivating \u2014 the vault feels alive.</p>
<ul style="${S.ul}"><li style="${S.li}">Shipped the metadata panel for ${wl('markdown-wiki')}.</li><li style="${S.li}">Re-read ${wl('second-brain')}; tightened the opening.</li><li style="${S.li}">Logged today\u2019s review in ${wl('reading-habit')}.</li></ul>`;
    d['d-0624'] = `
<p style="${S.p}">A walk knocked two ideas together before they could fade. Noted on the spot.</p>
<ul style="${S.ul}"><li style="${S.li}">${wl('compounding')} and patience are the same virtue wearing different clothes.</li><li style="${S.li}">Started ${wl('beginning-of-infinity')} \u2014 dense, but the good kind.</li></ul>`;
    d['inbox'] = `
<p style="${S.p}">Unsorted captures. Process these into the vault, then delete.</p>
<ul style="${S.ul}"><li style="${S.li}">Idea: a daily note template that pre-links yesterday.</li><li style="${S.li}">Quote to find again \u2014 something about ${wl('serendipity')} and surface area.</li></ul>`;
    return d;
  }

  bodyHTML(id){
    if (this.bodies[id] != null) return this.bodies[id];
    if (!this._defaults) this._defaults = this.buildAtlasDefaults();
    if (this._defaults[id]) return this._defaults[id];
    return `<p style="${this.S.p}">A new, empty note. Start writing \u2014 type <span style="${this.S.ic}">[[</span> to link it into the vault.</p>`;
  }

  undirectedEdges(){
    const seen = new Set(), out = [];
    for (const [a,b] of this.edges){ const k = a < b ? a+'|'+b : b+'|'+a; if (!seen.has(k) && this.note(a) && this.note(b)){ seen.add(k); out.push([a,b]); } }
    return out;
  }
  neighbors(id){ const s = new Set(); for (const [a,b] of this.edges){ if (a===id) s.add(b); if (b===id) s.add(a); } return [...s]; }
  degree(id){ return this.neighbors(id).length; }
  outgoingOf(id){ const s = new Set(); for (const [a,b] of this.edges){ if (a===id) s.add(b); } return [...s].filter(x => this.note(x)); }
  backlinksOf(id){ const s = new Set(); for (const [a,b] of this.edges){ if (b===id) s.add(a); } return [...s].filter(x => this.note(x)); }

  // ---------- navigation ----------
  openNote(id){
    if (!this.note(id) && !this.notes.find(n=>n.id===id)) return;
    const body = this.bodyHTML(id);
    const tmp = document.createElement('div'); tmp.innerHTML = body;
    const outline = [...tmp.querySelectorAll('h2')].map((h,i) => ({ i, text: h.textContent }));
    const words = (tmp.textContent.trim().match(/\S+/g) || []).length;
    this.setState({ activeId: id, outline, words, projectMenu:false, palette:{open:false,q:''}, graph:{...this.state.graph, open:false}, linkMenu:{...this.state.linkMenu, open:false}, slashMenu:{...this.state.slashMenu, open:false}, selBar:{open:false,left:0,top:0}, preview:{open:false,id:null,left:0,top:0} });
  }

  toggleFolder(id){ this.setState(s => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })); }
  toggleTheme(){ this.setState(s => ({ theme: s.theme === 'light' ? 'dark' : 'light' })); }

  newNote(){
    let n = 1; while (this.notes.find(x => x.id === 'untitled-'+n)) n++;
    const id = 'untitled-'+n;
    const note = { id, title:'Untitled '+n, folder:null, type:'concept', status:'seedling', planted:'2026-06-26', updated:'2026-06-26', tags:['fleeting'], excerpt:'A fresh, empty note.' };
    this.notes.push(note); this._layout = null;
    this.openNote(id);
  }

  // ---------- palette ----------
  openPalette(){ this.setState({ palette:{open:true,q:''}, paletteIdx:0 }); setTimeout(() => { if (this._pal) this._pal.focus(); }, 30); }
  closePalette(){ this.setState({ palette:{open:false,q:''} }); }
  setPaletteRef(el){ this._pal = el; }
  onPaletteInput(e){ this.setState({ palette:{open:true,q:e.target.value}, paletteIdx:0 }); }
  paletteData(){
    const q = (this.state.palette.q||'').toLowerCase().trim();
    const cmds = [
      { kind:'cmd', icon:'\u25d0', label:'Toggle theme', hint:'appearance', run:()=>{ this.toggleTheme(); this.closePalette(); } },
      { kind:'cmd', icon:'\u25c9', label:'Open graph view', hint:'view', run:()=>{ this.closePalette(); this.openGraph(); } },
      { kind:'cmd', icon:'+', label:'New note', hint:'create', run:()=>{ this.closePalette(); this.newNote(); } },
    ];
    const notes = this.notes.map(n => ({ kind:'note', icon:this.typeGlyph(n.type), label:n.title, hint:n.type, run:()=>{ this.closePalette(); this.openNote(n.id); } }));
    let rows = [...cmds, ...notes];
    if (q) rows = rows.filter(r => r.label.toLowerCase().includes(q));
    return rows.slice(0, 8);
  }
  onPaletteKey(e){
    const rows = this.paletteData();
    if (e.key === 'Escape'){ this.closePalette(); return; }
    if (e.key === 'ArrowDown'){ e.preventDefault(); this.setState(s => ({ paletteIdx: Math.min(rows.length-1, s.paletteIdx+1) })); return; }
    if (e.key === 'ArrowUp'){ e.preventDefault(); this.setState(s => ({ paletteIdx: Math.max(0, s.paletteIdx-1) })); return; }
    if (e.key === 'Enter'){ e.preventDefault(); const r = rows[this.state.paletteIdx]; if (r) r.run(); else if (this.state.palette.q.trim()){ this.createNamed(this.state.palette.q.trim()); } }
  }
  createNamed(name){
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || ('note-'+Date.now());
    if (!this.notes.find(n=>n.id===id)){ this.notes.push({ id, title:name, folder:null, type:'concept', status:'seedling', planted:'2026-06-26', updated:'2026-06-26', tags:['fleeting'], excerpt:'A fresh, empty note.' }); this._layout = null; }
    this.closePalette(); this.openNote(id);
  }
  typeGlyph(t){ return t==='daily'?'\u25d1':t==='source'?'\u25c8':t==='project'?'\u25c9':t==='inbox'?'\u25cc':'\u25c6'; }

  // ---------- graph ----------
  openGraph(){ this.setState(s => ({ graph:{open:true,hover:null} })); }
  closeGraph(){ this.setState(s => ({ graph:{...s.graph, open:false} })); }
  ensureLayout(){
    if (this._layout && this._layout.n === this.notes.length) return;
    const W=900,H=600,pad=64;
    const ids=this.allIds();
    const ns=ids.map((id,i)=>({id, x:W/2+Math.cos(i*2.3999)*(150+i*4), y:H/2+Math.sin(i*2.3999)*(130+i*3), dx:0,dy:0}));
    const idx={}; ns.forEach((n,i)=>idx[n.id]=i);
    const es=this.undirectedEdges().filter(e=>idx[e[0]]!=null&&idx[e[1]]!=null);
    const k=Math.sqrt(W*H/ns.length)*0.62; let temp=W*0.10;
    for(let it=0;it<280;it++){
      for(const n of ns){n.dx=0;n.dy=0;}
      for(let i=0;i<ns.length;i++)for(let j=i+1;j<ns.length;j++){
        let dx=ns[i].x-ns[j].x, dy=ns[i].y-ns[j].y, d=Math.hypot(dx,dy)||0.01, rep=k*k/d, ux=dx/d, uy=dy/d;
        ns[i].dx+=ux*rep; ns[i].dy+=uy*rep; ns[j].dx-=ux*rep; ns[j].dy-=uy*rep;
      }
      for(const [a,b] of es){ const A=ns[idx[a]],B=ns[idx[b]]; let dx=A.x-B.x,dy=A.y-B.y,d=Math.hypot(dx,dy)||0.01,att=d*d/k,ux=dx/d,uy=dy/d; A.dx-=ux*att;A.dy-=uy*att;B.dx+=ux*att;B.dy+=uy*att; }
      for(const n of ns){ n.dx+=(W/2-n.x)*0.013; n.dy+=(H/2-n.y)*0.013; }
      for(const n of ns){ let d=Math.hypot(n.dx,n.dy)||0.01, m=Math.min(d,temp); n.x+=n.dx/d*m; n.y+=n.dy/d*m; n.x=Math.max(pad,Math.min(W-pad,n.x)); n.y=Math.max(pad,Math.min(H-pad,n.y)); }
      temp*=0.984;
    }
    const pos={}; ns.forEach(n=>pos[n.id]={x:n.x,y:n.y});
    this._layout={W,H,pos,n:this.notes.length};
  }

  // ---------- editor / link autocomplete ----------
  setHeroRef(el){ this._hero = el; }
  setEditorRef(el){ this._ed = el; }
  scale(){ if (!this._hero) return 1; const r=this._hero.getBoundingClientRect(); const w=this._hero.offsetWidth||1; return r.width/w || 1; }

  /**
   * Place a floating menu relative to the caret rect, flipping above the line when
   * there isn't room below, and capping its height to the available space so the
   * options stay scrollable instead of overflowing off-screen.
   */
  menuPlace(rect, width, rowCount, rowH, chromeH){
    const hr=this._hero.getBoundingClientRect(); const sc=this.scale();
    const H=this._hero.offsetHeight, Wd=this._hero.offsetWidth;
    let left=(rect.left-hr.left)/sc; left=Math.max(8, Math.min(left, Wd-width-8));
    const caretTop=(rect.top-hr.top)/sc, caretBottom=(rect.bottom-hr.top)/sc;
    const gap=6, estH=chromeH+rowCount*rowH;
    const spaceBelow=H-caretBottom-gap-8, spaceAbove=caretTop-gap-8;
    let top, maxH;
    if(estH<=spaceBelow || spaceBelow>=spaceAbove){ top=caretBottom+gap; maxH=Math.min(estH, Math.max(120, spaceBelow)); }
    else { maxH=Math.min(estH, Math.max(120, spaceAbove)); top=Math.max(8, caretTop-gap-maxH); }
    return { left, top, maxH };
  }

  onEditorClick(e){
    const box = e.target.closest && e.target.closest('.task-box');
    if (box){ e.preventDefault(); const on=box.getAttribute('data-checked')==='1'; box.setAttribute('data-checked', on?'0':'1'); box.style.background=on?'transparent':'var(--accent)'; box.style.borderColor=on?'var(--muted)':'var(--accent)'; box.innerHTML=on?'':'<span style="color:#fff;font-size:11px;line-height:1;">\u2713</span>'; this.persist(); return; }
    const a = e.target.closest && e.target.closest('[data-link]');
    if (a){ e.preventDefault(); const id=a.getAttribute('data-link'); this.openNote(id); }
  }
  onEditorInput(){ this.persist(); this.maybeLink(); this.maybeSlash(); if(this.state.layout==='dual') this.updateMd(); }
  onEditorKeyUp(e){ if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){ this.maybeLink(); this.maybeSlash(); } this.checkSelection(); }
  onEditorKeyDown(e){
    if (this.state.slashMenu.open){
      const rows=this.slashData();
      if (e.key==='ArrowDown'){ e.preventDefault(); this.setState(s=>({slashMenu:{...s.slashMenu, idx:Math.min(rows.length-1,s.slashMenu.idx+1)}})); return; }
      if (e.key==='ArrowUp'){ e.preventDefault(); this.setState(s=>({slashMenu:{...s.slashMenu, idx:Math.max(0,s.slashMenu.idx-1)}})); return; }
      if (e.key==='Enter' || e.key==='Tab'){ e.preventDefault(); const r=rows[this.state.slashMenu.idx]; if (r) this.runSlash(r); return; }
      if (e.key==='Escape'){ e.preventDefault(); this.closeSlash(); return; }
    }
    if (this.state.linkMenu.open){
      const rows=this.linkData();
      if (e.key==='ArrowDown'){ e.preventDefault(); this.setState(s=>({linkMenu:{...s.linkMenu, idx:Math.min(rows.length-1,s.linkMenu.idx+1)}})); return; }
      if (e.key==='ArrowUp'){ e.preventDefault(); this.setState(s=>({linkMenu:{...s.linkMenu, idx:Math.max(0,s.linkMenu.idx-1)}})); return; }
      if (e.key==='Enter' || e.key==='Tab'){ e.preventDefault(); const r=rows[this.state.linkMenu.idx]; if (r) r.run(); return; }
      if (e.key==='Escape'){ e.preventDefault(); this.closeLinkMenu(); return; }
    }
    if (e.key===' '){ const blk=this.currentBlock(); if (blk && blk.tagName!=='PRE'){ const pre=this.textBeforeCaret(blk); const tok={'#':'h1','##':'h2','###':'h3','>':'quote','-':'ul','*':'ul','[]':'task','[ ]':'task'}; if (tok[pre]!==undefined){ e.preventDefault(); this.stripLeading(blk, pre.length); this.transformBlock(blk, tok[pre]); return; } } }
    if (e.key==='Enter'){ const blk=this.currentBlock(); if (blk && blk.tagName!=='PRE'){ const pre=this.textBeforeCaret(blk); if (pre==='---'||pre==='***'){ e.preventDefault(); this.stripLeading(blk, pre.length); this.transformBlock(blk, 'hr'); return; } } }
  }
  closeLinkMenu(){ this._anchor=null; this.setState(s=>({linkMenu:{...s.linkMenu, open:false}})); }
  persist(){ if (this._ed && this.state.activeId){ this.bodies[this.state.activeId]=this._ed.innerHTML; const w=(this._ed.textContent.trim().match(/\S+/g)||[]).length; if (w!==this.state.words) this.setState({words:w, saved:'Saving\u2026'}); clearTimeout(this._sv); this._sv=setTimeout(()=>this.setState({saved:'Saved'}),700); } }

  maybeLink(){
    const sel=window.getSelection();
    if (!sel || !sel.rangeCount){ if (this.state.linkMenu.open) this.closeLinkMenu(); return; }
    const range=sel.getRangeAt(0);
    if (!range.collapsed){ if (this.state.linkMenu.open) this.closeLinkMenu(); return; }
    const node=range.startContainer;
    if (!node || node.nodeType!==3){ if (this.state.linkMenu.open) this.closeLinkMenu(); return; }
    const text=node.textContent.slice(0,range.startOffset);
    const m=text.match(/\[\[([^\[\]\n]*)$/);
    if (!m){ if (this.state.linkMenu.open) this.closeLinkMenu(); return; }
    const q=m[1];
    this._anchor={ node, start: range.startOffset - m[0].length };
    const ql=q.toLowerCase();
    let cnt=this.notes.filter(n=>n.id!==this.state.activeId && (!ql||n.title.toLowerCase().includes(ql))).length;
    cnt=Math.min(cnt,6)+((ql && !this.notes.find(n=>n.title.toLowerCase()===ql))?1:0);
    const lm=this.state.linkMenu;
    const keep=lm.open&&lm.q===q?Math.min(lm.idx,Math.max(0,cnt-1)):0;
    const pos=this.menuPlace(range.getBoundingClientRect(), 288, cnt, 34, 30);
    this.setState({ linkMenu:{ open:true, q, idx:keep, left:pos.left, top:pos.top, maxH:pos.maxH } });
  }

  linkData(){
    const q=(this.state.linkMenu.q||'').toLowerCase();
    let list=this.notes.filter(n=>n.id!==this.state.activeId);
    if (q) list=list.filter(n=>n.title.toLowerCase().includes(q));
    const rows=list.slice(0,6).map(n=>({ kind:'note', title:n.title, sub:n.type, icon:this.typeGlyph(n.type), run:()=>this.insertLink(n.id) }));
    if (q && !this.notes.find(n=>n.title.toLowerCase()===q)){ rows.push({ kind:'new', title:'Create \u201c'+this.state.linkMenu.q+'\u201d', sub:'new', icon:'+', run:()=>this.insertCreateLink(this.state.linkMenu.q) }); }
    return rows;
  }
  insertLink(id){
    const a=this._anchor; if (!a){ this.closeLinkMenu(); return; }
    const sel=window.getSelection(); const cur=sel.getRangeAt(0);
    const r=document.createRange(); r.setStart(a.node, a.start); r.setEnd(cur.startContainer, cur.startOffset); r.deleteContents();
    const tpl=document.createElement('template'); tpl.innerHTML=this.wl(id)+'\u00a0';
    const frag=tpl.content; const last=frag.lastChild;
    r.insertNode(frag);
    const nr=document.createRange(); nr.setStartAfter(last); nr.collapse(true);
    sel.removeAllRanges(); sel.addRange(nr);
    this._anchor=null; this.setState(s=>({linkMenu:{...s.linkMenu,open:false}}));
    this.persist(); if (this._ed) this._ed.focus();
  }
  insertCreateLink(name){
    const id=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||('note-'+Date.now());
    if (!this.notes.find(n=>n.id===id)){ this.notes.push({ id, title:name, folder:null, type:'concept', status:'seedling', planted:'2026-06-26', updated:'2026-06-26', tags:['fleeting'], excerpt:'A fresh, empty note.' }); this._layout=null; }
    this.edges.push([this.state.activeId, id]);
    this.insertLink(id);
  }

  // ---------- lifecycle ----------
  componentDidMount(){
    this.initVaults();
    this._key=(e)=>{
      if ((e.metaKey||e.ctrlKey) && (e.key==='k'||e.key==='K')){ e.preventDefault(); if (this.state.palette.open) this.closePalette(); else this.openPalette(); }
      else if (e.key==='Escape'){ if (this.state.selBar.blockOpen) this.closeBlockMenu(); else if (this.state.projectMenu) this.closeProjectMenu(); else if (this.state.graph.open) this.closeGraph(); else if (this.state.palette.open) this.closePalette(); }
    };
    document.addEventListener('keydown', this._key);
    this._docDown=(e)=>{ if(this.state.selBar.blockOpen && this._selBarEl && !this._selBarEl.contains(e.target)) this.closeBlockMenu(); };
    document.addEventListener('mousedown', this._docDown, true);
    if (this._ed){ this._ed.innerHTML=this.bodyHTML(this.state.activeId); }
    this.openNote(this.state.activeId);
    this._loadedId=this.state.activeId;
  }
  componentDidUpdate(prevProps, prevState){
    if (this._ed && this._loadedId!==this.state.activeId){ this._ed.innerHTML=this.bodyHTML(this.state.activeId); this._ed.scrollTop=0; const sc=this._ed.closest('.scroll'); if (sc) sc.scrollTop=0; this._loadedId=this.state.activeId; if (this.state.layout==='dual') this.updateMd(); }
    if (this.state.layout==='dual' && prevState && prevState.layout!=='dual') this.updateMd();
  }
  componentWillUnmount(){ document.removeEventListener('keydown', this._key); document.removeEventListener('mousedown', this._docDown, true); }

  scrollToHeading(i){ if (!this._ed) return; const hs=this._ed.querySelectorAll('h2'); if (hs[i]){ const sc=this._ed.closest('.scroll'); if (sc){ sc.scrollTo({ top: hs[i].offsetTop - 24, behavior:'smooth' }); } } }

  // ---------- layout / dual ----------
  setLayout(m){ this.setState({ layout:m, preview:{open:false,id:null,left:0,top:0}, selBar:{open:false,left:0,top:0} }); if(m==='dual') setTimeout(()=>this.updateMd(),0); }
  updateMd(){ if(!this._ed) return; const md=this.html2md(this._ed.innerHTML); if(md!==this.state.md) this.setState({md}); }
  copyMarkdown(){ const md=this.state.md||''; const after=()=>{ this.setState({mdCopied:true}); clearTimeout(this._cp); this._cp=setTimeout(()=>this.setState({mdCopied:false}),1400); }; try{ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(md).then(after,()=>{ this.fallbackCopy(md); after(); }); return; } }catch(e){} this.fallbackCopy(md); after(); }
  fallbackCopy(text){ try{ const ta=document.createElement('textarea'); ta.value=text; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.top='-1000px'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }catch(e){} }
  html2md(html){
    const root=document.createElement('div'); root.innerHTML=html;
    const inline=(node)=>{ let s=''; node.childNodes.forEach(c=>{ if(c.nodeType===3) s+=c.nodeValue; else if(c.nodeType===1){ const t=c.tagName; if(c.hasAttribute&&c.hasAttribute('data-link')) s+='[['+c.textContent+']]'; else if(t==='STRONG'||t==='B') s+='**'+inline(c)+'**'; else if(t==='EM'||t==='I') s+='*'+inline(c)+'*'; else if(t==='CODE') s+='`'+c.textContent+'`'; else if(t==='BR') s+='\n'; else if(t==='SPAN'){ const st=c.getAttribute('style')||''; if(/code-bg/.test(st)) s+='`'+c.textContent+'`'; else if(/accent-soft/.test(st)) s+='=='+c.textContent+'=='; else s+=inline(c); } else s+=inline(c); } }); return s; };
    const out=[];
    root.childNodes.forEach(node=>{ if(node.nodeType!==1){ const tx=(node.nodeValue||'').trim(); if(tx) out.push(tx); return; } const t=node.tagName; const st=node.getAttribute('style')||'';
      if(t==='H1') out.push('# '+inline(node));
      else if(t==='H2') out.push('## '+inline(node));
      else if(t==='H3') out.push('### '+inline(node));
      else if(t==='P') out.push(inline(node));
      else if(t==='BLOCKQUOTE') out.push('> '+inline(node).replace(/\n/g,'\n> '));
      else if(t==='UL'){ node.querySelectorAll(':scope > li').forEach(li=>out.push('- '+inline(li))); }
      else if(t==='OL'){ let i=1; node.querySelectorAll(':scope > li').forEach(li=>out.push((i++)+'. '+inline(li))); }
      else if(t==='PRE') out.push('```\n'+node.textContent.replace(/\n+$/,'')+'\n```');
      else if(t==='HR') out.push('---');
      else if(t==='DIV'){ const box=node.querySelector(':scope > .task-box'); if(/accent-soft/.test(st)&&node.firstElementChild&&node.querySelector('p')){ const label=(node.firstElementChild.textContent||'').replace(/[^A-Za-z]/g,'')||'note'; const body=[...node.querySelectorAll(':scope > p')].map(p=>inline(p)).join('\n').replace(/\n/g,'\n> '); out.push('> [!'+label.toLowerCase()+'] '+body); } else if(box){ const span=node.querySelector(':scope > span:last-child'); const ch=box.getAttribute('data-checked')==='1'; out.push('- ['+(ch?'x':' ')+'] '+(span?inline(span):'')); } else out.push(inline(node)); }
      else out.push(inline(node)); });
    return out.join('\n\n');
  }

  // ---------- editor blocks ----------
  currentBlock(){ const sel=window.getSelection(); if(!sel||!sel.rangeCount||!this._ed) return null; let node=sel.getRangeAt(0).startContainer; if(node===this._ed){ const off=sel.getRangeAt(0).startOffset; node=this._ed.childNodes[off]||this._ed.lastChild; } while(node&&node.parentNode&&node.parentNode!==this._ed) node=node.parentNode; if(!node||node===this._ed) return null; return node.nodeType===1?node:null; }
  textBeforeCaret(blk){ const sel=window.getSelection(); if(!sel.rangeCount) return ''; const r=sel.getRangeAt(0); const pre=document.createRange(); pre.selectNodeContents(blk); try{ pre.setEnd(r.startContainer, r.startOffset); }catch(e){ return ''; } return pre.toString(); }
  stripLeading(blk,n){ const w=document.createTreeWalker(blk, NodeFilter.SHOW_TEXT); const tn=w.nextNode(); if(tn) tn.nodeValue=tn.nodeValue.slice(n); }
  /** Ensure a block-content element is editable: an empty element (or one left
   *  with only an empty text node after stripLeading) collapses in contentEditable
   *  and ejects the caret — give it a <br> placeholder so the caret can rest in it. */
  fill(el){ if(!el.firstChild || el.textContent===''){ while(el.firstChild) el.removeChild(el.firstChild); el.appendChild(document.createElement('br')); } }
  caretToStart(el){ const r=document.createRange(); r.selectNodeContents(el); r.collapse(true); const s=window.getSelection(); s.removeAllRanges(); s.addRange(r); }
  transformBlock(blk,type){ const S=this.S;
    if(type==='ul'){ const li=document.createElement('li'); li.setAttribute('style',S.li); while(blk.firstChild) li.appendChild(blk.firstChild); this.fill(li); const prev=blk.previousElementSibling; if(prev&&prev.tagName==='UL'){ prev.appendChild(li); blk.remove(); } else { const ul=document.createElement('ul'); ul.setAttribute('style',S.ul); ul.appendChild(li); blk.replaceWith(ul); } this.caretToStart(li); this.persist(); return; }
    if(type==='task'){ const div=document.createElement('div'); div.setAttribute('style',S.task); const box=document.createElement('span'); box.className='task-box'; box.setAttribute('contenteditable','false'); box.setAttribute('data-checked','0'); box.setAttribute('style','width:17px;height:17px;border:1.6px solid var(--muted);border-radius:5px;flex:0 0 17px;margin-top:3px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;'); const span=document.createElement('span'); span.setAttribute('style','flex:1;'); while(blk.firstChild) span.appendChild(blk.firstChild); this.fill(span); div.appendChild(box); div.appendChild(span); blk.replaceWith(div); this.caretToStart(span); this.persist(); return; }
    if(type==='hr'){ const hr=document.createElement('hr'); hr.setAttribute('style',S.hr); const p=document.createElement('p'); p.setAttribute('style',S.p); p.appendChild(document.createElement('br')); blk.replaceWith(hr); hr.after(p); this.caretToStart(p); this.persist(); return; }
    if(type==='code'){ const pre=document.createElement('pre'); pre.setAttribute('style',S.code); pre.textContent=(blk.textContent||'')||' '; blk.replaceWith(pre); this.caretToStart(pre); this.persist(); return; }
    if(type==='callout'){ const d=document.createElement('div'); d.setAttribute('style',S.callout); const tt=document.createElement('div'); tt.setAttribute('style',S.cT); tt.textContent='\u25c6  Note'; const p=document.createElement('p'); p.setAttribute('style',S.cP); while(blk.firstChild) p.appendChild(blk.firstChild); this.fill(p); d.appendChild(tt); d.appendChild(p); blk.replaceWith(d); this.caretToStart(p); this.persist(); return; }
    const map={ h1:['h1',S.h1], h2:['h2',S.h2], h3:['h3',S.h3], quote:['blockquote',S.quote], p:['p',S.p] }; const [tag,style]=map[type]||map.p; const el=document.createElement(tag); el.setAttribute('style',style); while(blk.firstChild) el.appendChild(blk.firstChild); this.fill(el); blk.replaceWith(el); this.caretToStart(el); this.persist(); }

  // ---------- slash menu ----------
  maybeSlash(){ const sel=window.getSelection(); if(!sel||!sel.rangeCount){ if(this.state.slashMenu.open) this.closeSlash(); return; } const r=sel.getRangeAt(0); if(!r.collapsed){ if(this.state.slashMenu.open) this.closeSlash(); return; } const blk=this.currentBlock(); if(!blk||blk.tagName==='PRE'){ if(this.state.slashMenu.open) this.closeSlash(); return; } const pre=this.textBeforeCaret(blk); const m=pre.match(/^\/([\w-]*)$/); if(!m){ if(this.state.slashMenu.open) this.closeSlash(); return; } this._slashBlk=blk; const q=m[1]; const ql=q.toLowerCase(); const rowsN=this.slashItems().filter(x=>!ql||x.label.toLowerCase().includes(ql)||x.type.includes(ql)).length; const sm=this.state.slashMenu; const keep=sm.open&&sm.q===q?Math.min(sm.idx,Math.max(0,rowsN-1)):0; const pos=this.menuPlace(r.getBoundingClientRect(), 228, rowsN, 32, 38); this.setState({ slashMenu:{ open:true, q, idx:keep, left:pos.left, top:pos.top, maxH:pos.maxH } }); }
  closeSlash(){ this._slashBlk=null; this.setState(s=>({slashMenu:{...s.slashMenu, open:false}})); }
  slashItems(){ return [ {label:'Heading 1',hint:'#',type:'h1'},{label:'Heading 2',hint:'##',type:'h2'},{label:'Heading 3',hint:'###',type:'h3'},{label:'To-do',hint:'[ ]',type:'task'},{label:'Bullet list',hint:'\u2013',type:'ul'},{label:'Quote',hint:'\u201c',type:'quote'},{label:'Code block',hint:'</>',type:'code'},{label:'Callout',hint:'\u25c6',type:'callout'},{label:'Divider',hint:'\u2014',type:'hr'} ]; }
  slashData(){ const q=(this.state.slashMenu.q||'').toLowerCase(); let it=this.slashItems(); if(q) it=it.filter(x=>x.label.toLowerCase().includes(q)||x.type.includes(q)); return it; }
  runSlash(item){ const blk=this._slashBlk; const q=this.state.slashMenu.q||''; this.closeSlash(); if(!blk) return; this.stripLeading(blk, 1+q.length); this.transformBlock(blk, item.type); if(this._ed) this._ed.focus(); }

  // ---------- selection toolbar ----------
  checkSelection(){ const sel=window.getSelection(); if(!sel||!sel.rangeCount||sel.isCollapsed||!this._ed){ if(this.state.selBar.open) this.setState(s=>({selBar:{...s.selBar,open:false}})); return; } const r=sel.getRangeAt(0); if(!this._ed.contains(r.commonAncestorContainer)){ if(this.state.selBar.open) this.setState(s=>({selBar:{...s.selBar,open:false}})); return; } const rect=r.getBoundingClientRect(); if(!rect.width&&!rect.height) return; const hr=this._hero.getBoundingClientRect(); const sc=this.scale(); let left=(rect.left+rect.width/2-hr.left)/sc; let top=(rect.top-hr.top)/sc-44; if(top<8) top=(rect.bottom-hr.top)/sc+8; left=Math.max(150,Math.min(left,this._hero.offsetWidth-150)); this.setState({ selBar:{ open:true, left, top, fmt:this.selectionFormats(), blockType:this.currentBlockType(), blockOpen:false } }); }
  /** Inspect the current selection so the toolbar can show which styles are already active. */
  selectionFormats(){ const f={bold:false,italic:false,code:false,highlight:false,link:false}; try{ f.bold=!!document.queryCommandState('bold'); f.italic=!!document.queryCommandState('italic'); }catch(e){} const sel=window.getSelection(); if(sel&&sel.rangeCount&&this._ed){ let node=sel.getRangeAt(0).commonAncestorContainer; if(node&&node.nodeType===3) node=node.parentNode; let n=node; while(n&&n!==this._ed){ if(n.nodeType===1){ const st=n.getAttribute('style')||''; if(n.tagName==='SPAN'&&/code-bg/.test(st)) f.code=true; if(n.tagName==='SPAN'&&/accent-soft/.test(st)) f.highlight=true; if(n.hasAttribute&&n.hasAttribute('data-link')) f.link=true; } n=n.parentNode; } } return f; }
  closeSelBar(){ this.setState(s=>({selBar:{...s.selBar,open:false}})); }
  // ---------- block-type selector ----------
  isTask(b){ return b.tagName==='DIV' && !!b.querySelector(':scope > .task-box'); }
  isCallout(b){ return b.tagName==='DIV' && !this.isTask(b) && /accent-soft/.test(b.getAttribute('style')||''); }
  blockTypeOf(b){ const t=b.tagName; if(t==='H1')return'h1'; if(t==='H2')return'h2'; if(t==='H3')return'h3'; if(t==='BLOCKQUOTE')return'quote'; if(t==='UL'||t==='OL')return'ul'; if(t==='PRE')return'code'; if(t==='HR')return'hr'; if(this.isTask(b))return'task'; if(this.isCallout(b))return'callout'; return 'p'; }
  blocksInRange(range){ const ed=this._ed; if(!ed) return []; const topOf=(node,off,isEnd)=>{ let n=node; if(n===ed){ const idx=isEnd?off-1:off; n=ed.childNodes[idx]||(isEnd?ed.lastChild:ed.firstChild); } else if(n&&n.nodeType===3){ n=n.parentNode; } while(n&&n.parentNode&&n.parentNode!==ed) n=n.parentNode; return (n&&n.parentNode===ed)?n:null; }; let start=topOf(range.startContainer, range.startOffset, false); let end=topOf(range.endContainer, range.endOffset, true)||start; if(!start) return []; if(end!==start && range.endContainer!==ed && range.endOffset===0){ let atStart=true, p=range.endContainer; while(p&&p!==end){ if(p.previousSibling){ atStart=false; break; } p=p.parentNode; } if(atStart){ const prev=end.previousElementSibling; if(prev) end=prev; } } if(end!==start && range.startContainer!==ed && range.startContainer.nodeType===3 && range.startOffset===(range.startContainer.textContent||'').length){ let atEnd=true, p=range.startContainer; while(p&&p!==start){ if(p.nextSibling){ atEnd=false; break; } p=p.parentNode; } if(atEnd){ const next=start.nextElementSibling; if(next) start=next; } } const out=[]; let cur=start; while(cur){ if(cur.nodeType===1) out.push(cur); if(cur===end) break; cur=cur.nextElementSibling; } return out; }
  currentBlockType(){ const sel=window.getSelection(); if(!sel||!sel.rangeCount||!this._ed) return 'p'; const blocks=this.blocksInRange(sel.getRangeAt(0)).filter(b=>b.tagName!=='HR'); if(!blocks.length) return 'p'; const types=new Set(blocks.map(b=>this.blockTypeOf(b))); return types.size===1 ? [...types][0] : 'mixed'; }
  blockTypeOptions(){ return [ {type:'p',label:'Text',hint:'¶'},{type:'h1',label:'Heading 1',hint:'H1'},{type:'h2',label:'Heading 2',hint:'H2'},{type:'h3',label:'Heading 3',hint:'H3'},{type:'quote',label:'Quote',hint:'“'},{type:'ul',label:'Bullet list',hint:'•'},{type:'task',label:'To-do',hint:'✓'},{type:'code',label:'Code',hint:'</>'},{type:'callout',label:'Callout',hint:'◆'} ]; }
  blockShort(type){ const m={p:'Text',h1:'Heading 1',h2:'Heading 2',h3:'Heading 3',quote:'Quote',ul:'Bullet list',task:'To-do',code:'Code',callout:'Callout',hr:'Divider',mixed:'Mixed'}; return m[type]||'Text'; }
  toggleBlockMenu(){ this.setState(s=>({selBar:{...s.selBar, blockOpen:!s.selBar.blockOpen}})); }
  closeBlockMenu(){ this.setState(s=>({selBar:{...s.selBar, blockOpen:false}})); }
  esc(t){ const d=document.createElement('div'); d.textContent=t; return d.innerHTML; }
  lineHTMLsOf(b){ if(b.tagName==='UL'||b.tagName==='OL'){ return [...b.querySelectorAll(':scope > li')].map(li=>li.innerHTML); } if(this.isTask(b)){ const span=b.querySelector(':scope > span:last-child'); return [span?span.innerHTML:this.esc(b.textContent||'')]; } if(this.isCallout(b)){ const ps=[...b.querySelectorAll(':scope > p')]; return ps.length?ps.map(p=>p.innerHTML):['']; } if(b.tagName==='PRE'){ return (b.textContent||'').split('\n').map(t=>this.esc(t)); } return [b.innerHTML]; }
  setBlockType(type){ const sel=window.getSelection(); if(!sel||!sel.rangeCount||!this._ed){ this.closeBlockMenu(); return; } const all=this.blocksInRange(sel.getRangeAt(0)); if(!all.length){ this.closeBlockMenu(); return; } const ed=this._ed; const runs=[]; let run=[]; for(const b of all){ if(b.tagName==='HR'){ if(run.length){ runs.push(run); run=[]; } } else run.push(b); } if(run.length) runs.push(run); let firstNode=null, lastNode=null; for(const blocks of runs){ let lines=[], checks=[], title=''; for(const b of blocks){ if(this.isCallout(b) && !title){ const tt=b.firstElementChild; title=tt?(tt.textContent||'').trim():''; } const ls=this.lineHTMLsOf(b); const isT=this.isTask(b); const box=isT?b.querySelector(':scope > .task-box'):null; const ch=!!(box && box.getAttribute('data-checked')==='1'); for(const l of ls){ lines.push(l); checks.push(isT?ch:false); } } if(!lines.length){ lines=['']; checks=[false]; } const nodes=this.buildBlocks(type, lines, checks, title); const anchor=blocks[0]; for(const nd of nodes) ed.insertBefore(nd, anchor); for(const b of blocks) b.remove(); if(nodes.length){ if(!firstNode) firstNode=nodes[0]; lastNode=nodes[nodes.length-1]; } } if(firstNode&&lastNode){ const r=document.createRange(); r.setStart(firstNode,0); r.setEnd(lastNode, lastNode.childNodes.length); const s=window.getSelection(); s.removeAllRanges(); s.addRange(r); } this.persist(); if(this.state.layout==='dual') this.updateMd(); if(this._ed) this._ed.focus(); this.checkSelection(); }
  buildBlocks(type, lines, checks, title){ const S=this.S; const out=[]; const make=(tag,style,html)=>{ const e=document.createElement(tag); if(style) e.setAttribute('style',style); e.innerHTML=(html&&html.trim())?html:'<br>'; return e; }; if(type==='h1'||type==='h2'||type==='h3'){ for(const h of lines) out.push(make(type,S[type],h)); } else if(type==='quote'){ for(const h of lines) out.push(make('blockquote',S.quote,h)); } else if(type==='ul'){ const ul=document.createElement('ul'); ul.setAttribute('style',S.ul); for(const h of lines) ul.appendChild(make('li',S.li,h)); out.push(ul); } else if(type==='task'){ lines.forEach((h,i)=> out.push(this.makeTask(h, checks&&checks[i]))); } else if(type==='code'){ const pre=document.createElement('pre'); pre.setAttribute('style',S.code); const tmp=document.createElement('div'); pre.textContent=lines.map(h=>{ tmp.innerHTML=h; tmp.querySelectorAll('[data-link]').forEach(el=>{ el.replaceWith('[['+el.textContent+']]'); }); return tmp.textContent; }).join('\n')||' '; out.push(pre); } else if(type==='callout'){ out.push(this.makeCallout(lines, title)); } else { for(const h of lines) out.push(make('p',S.p,h)); } return out; }
  makeTask(html, checked){ const div=document.createElement('div'); div.setAttribute('style',this.S.task); const box=document.createElement('span'); box.className='task-box'; box.setAttribute('contenteditable','false'); box.setAttribute('data-checked', checked?'1':'0'); box.setAttribute('style','width:17px;height:17px;border:1.6px solid '+(checked?'var(--accent)':'var(--muted)')+';border-radius:5px;flex:0 0 17px;margin-top:3px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;'+(checked?'background:var(--accent);':'')); if(checked) box.innerHTML='<span style="color:#fff;font-size:11px;line-height:1;">✓</span>'; const span=document.createElement('span'); span.setAttribute('style','flex:1;'); span.innerHTML=(html&&html.trim())?html:'<br>'; div.appendChild(box); div.appendChild(span); return div; }
  makeCallout(lines, title){ const d=document.createElement('div'); d.setAttribute('style',this.S.callout); const tt=document.createElement('div'); tt.setAttribute('style',this.S.cT); tt.textContent=(title&&title.trim())?title:'◆  Note'; d.appendChild(tt); for(const h of lines){ const p=document.createElement('p'); p.setAttribute('style',this.S.cP); p.innerHTML=(h&&h.trim())?h:'<br>'; d.appendChild(p); } return d; }
  blockMenuPlace(){ const top=this.state.selBar.top||0; const heroH=this._hero?this._hero.offsetHeight:800; const est=this.blockTypeOptions().length*29+14; const barH=38; const below=heroH-top-barH-12; const up=est>below && top>below; const maxH=Math.max(150, up?(top-14):below); return { up, maxH }; }
  onEditorMouseUp(){ setTimeout(()=>this.checkSelection(),0); }
  wrapSelection(styleStr){ const sel=window.getSelection(); if(!sel.rangeCount||sel.isCollapsed) return; const r=sel.getRangeAt(0); const el=document.createElement('span'); el.setAttribute('style',styleStr); try{ r.surroundContents(el); }catch(err){ const f=r.extractContents(); el.appendChild(f); r.insertNode(el); } sel.removeAllRanges(); this.closeSelBar(); this.persist(); if(this._ed) this._ed.focus(); }
  fmtBold(){ document.execCommand('bold'); this.closeSelBar(); this.persist(); }
  fmtItalic(){ document.execCommand('italic'); this.closeSelBar(); this.persist(); }
  fmtCode(){ this.toggleWrap((st)=>/code-bg/.test(st), this.S.ic); }
  fmtHighlight(){ this.toggleWrap((st)=>/accent-soft/.test(st), 'background:var(--accent-soft);border-radius:3px;padding:0 3px;'); }
  /** Toggle an inline span style: unwrap the matching ancestor span if the
   *  selection is already inside one, otherwise wrap (so the bar toggles on/off). */
  toggleWrap(test, styleStr){
    const sel=window.getSelection(); if(!sel||!sel.rangeCount||sel.isCollapsed||!this._ed) return;
    const range=sel.getRangeAt(0);
    let node=range.commonAncestorContainer; if(node&&node.nodeType===3) node=node.parentNode;
    let target=null, n=node;
    while(n&&n!==this._ed){ if(n.nodeType===1&&n.tagName==='SPAN'&&!n.hasAttribute('data-link')&&test(n.getAttribute('style')||'')) target=n; n=n.parentNode; }
    if(target){
      const parent=target.parentNode; const r=document.createRange(); r.selectNodeContents(target);
      const frag=r.extractContents(); const first=frag.firstChild, last=frag.lastChild;
      parent.replaceChild(frag, target);
      if(first&&last){ const nr=document.createRange(); nr.setStartBefore(first); nr.setEndAfter(last); sel.removeAllRanges(); sel.addRange(nr); }
      this.closeSelBar(); this.persist(); if(this._ed) this._ed.focus(); return;
    }
    this.wrapSelection(styleStr);
  }
  fmtLink(){ const sel=window.getSelection(); if(!sel.rangeCount||sel.isCollapsed) return; const text=sel.toString().trim(); if(!text) return; let note=this.notes.find(n=>n.title.toLowerCase()===text.toLowerCase())||this.notes.find(n=>n.id!==this.state.activeId&&n.title.toLowerCase().includes(text.toLowerCase())); let id=note?note.id:null; if(!id){ id=text.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||('note-'+Date.now()); if(!this.notes.find(x=>x.id===id)){ this.notes.push({id,title:text,folder:null,type:'concept',status:'seedling',planted:'2026-06-26',updated:'2026-06-26',tags:['fleeting'],excerpt:'A fresh, empty note.'}); this._layout=null; } } const r=sel.getRangeAt(0); r.deleteContents(); const tpl=document.createElement('template'); tpl.innerHTML=this.wl(id); const pill=tpl.content.firstChild; r.insertNode(pill); if(!this.edges.find(e=>e[0]===this.state.activeId&&e[1]===id)) this.edges.push([this.state.activeId,id]); sel.removeAllRanges(); this.closeSelBar(); this.persist(); if(this._ed) this._ed.focus(); }

  // ---------- hover preview ----------
  showPreview(id,el){ if(!id||!this.note(id)||!this._hero||!el) return; clearTimeout(this._pvHide); const r=el.getBoundingClientRect(); const hr=this._hero.getBoundingClientRect(); const sc=this.scale(); let left=(r.left-hr.left)/sc; let top=(r.bottom-hr.top)/sc+8; const W=this._hero.offsetWidth, H=this._hero.offsetHeight; left=Math.max(10,Math.min(left,W-322)); if(top>H-150) top=(r.top-hr.top)/sc-140; clearTimeout(this._pvShow); this._pvShow=setTimeout(()=>this.setState({preview:{open:true,id,left,top}}),130); }
  hidePreview(){ clearTimeout(this._pvShow); this._pvHide=setTimeout(()=>this.setState(s=>({preview:{...s.preview,open:false}})),120); }
  onEditorOver(e){ const a=e.target.closest&&e.target.closest('[data-link]'); if(a) this.showPreview(a.getAttribute('data-link'), a); }
  onEditorOut(e){ const a=e.target.closest&&e.target.closest('[data-link]'); if(a) this.hidePreview(); }

  // ---------- mentions ----------
  stripPlain(html){ const t=document.createElement('div'); t.innerHTML=html; t.querySelectorAll('[data-link]').forEach(e=>e.remove()); return (t.textContent||'').replace(/\s+/g,' '); }
  unlinkedOf(id){ const T=this.title(id).toLowerCase(); if(T.length<3) return []; const linked=new Set(this.backlinksOf(id)); const out=[]; for(const nn of this.notes){ if(nn.id===id||linked.has(nn.id)) continue; if(this.stripPlain(this.bodyHTML(nn.id)).toLowerCase().includes(T)) out.push(nn.id); } return out; }
  setMentionsTab(t){ this.setState({mentionsTab:t}); }
  linkMention(mentionId){ const targetId=this.state.activeId; const T=this.title(targetId); const tmp=document.createElement('div'); tmp.innerHTML=this.bodyHTML(mentionId); const re=new RegExp(T.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'); const walker=document.createTreeWalker(tmp, NodeFilter.SHOW_TEXT); let node, done=false; while(!done&&(node=walker.nextNode())){ if(node.parentElement&&node.parentElement.closest('[data-link]')) continue; const m=node.nodeValue.match(re); if(m){ const i=m.index; const before=node.nodeValue.slice(0,i), after=node.nodeValue.slice(i+T.length); const tpl=document.createElement('template'); tpl.innerHTML=this.wl(targetId); const pill=tpl.content.firstChild; const frag=document.createDocumentFragment(); if(before) frag.appendChild(document.createTextNode(before)); frag.appendChild(pill); if(after) frag.appendChild(document.createTextNode(after)); node.parentNode.replaceChild(frag,node); done=true; } } this.bodies[mentionId]=tmp.innerHTML; if(!this.edges.find(e=>e[0]===mentionId&&e[1]===targetId)) this.edges.push([mentionId,targetId]); this._layout=null; this.setState({mentionsTab:'linked'}); }

  // ---------- graph modes ----------
  setGraphMode(m){ this.setState(s=>({graphMode:m, graph:{...s.graph, hover:null}})); }
  localLayout(A){ const inner=this.neighbors(A); const innerSet=new Set([A,...inner]); const outer=[], outerSet=new Set(); inner.forEach(i=>this.neighbors(i).forEach(o=>{ if(!innerSet.has(o)&&!outerSet.has(o)){ outerSet.add(o); outer.push(o); } })); const W=900,H=600,cx=W/2,cy=H/2; const pos={}; pos[A]={x:cx,y:cy}; const ri=150; inner.forEach((id,i)=>{ const ang=(i/Math.max(1,inner.length))*Math.PI*2-Math.PI/2; pos[id]={x:cx+Math.cos(ang)*ri, y:cy+Math.sin(ang)*ri}; }); outer.forEach((id,i)=>{ const ang=(i/Math.max(1,outer.length))*Math.PI*2-Math.PI/2+0.3; pos[id]={x:cx+Math.cos(ang)*255, y:cy+Math.sin(ang)*248}; }); return { pos, ids:[A,...inner,...outer] }; }
  folderLayout(){ const W=900,H=600; const order=['f-daily','f-projects','f-concepts','f-sources']; const groups={}; for(const n of this.notes){ const f=n.folder||'none'; (groups[f]=groups[f]||[]).push(n.id); } const fids=Object.keys(groups).sort((a,b)=>{ const ia=order.indexOf(a), ib=order.indexOf(b); return (ia<0?9:ia)-(ib<0?9:ib); }); const cols=Math.min(3,fids.length)||1; const rws=Math.ceil(fids.length/cols); const cents={}; fids.forEach((f,i)=>{ cents[f]={x:((i%cols)+0.5)/cols*W, y:((Math.floor(i/cols))+0.5)/rws*H}; }); const pos={}; fids.forEach(f=>{ const arr=groups[f], c=cents[f]; arr.forEach((id,j)=>{ if(arr.length===1){ pos[id]={x:c.x,y:c.y}; } else { const ang=(j/arr.length)*Math.PI*2; const rad=Math.min(105,34+arr.length*9); pos[id]={x:c.x+Math.cos(ang)*rad, y:c.y+Math.sin(ang)*rad*0.84}; } }); }); for(const id in pos){ pos[id].x=Math.max(58,Math.min(W-58,pos[id].x)); pos[id].y=Math.max(58,Math.min(H-58,pos[id].y)); } return { pos, ids:this.allIds() }; }
  folderColorOf(id){ const f=this.note(id).folder; const m={ 'f-concepts':'var(--accent)','f-sources':'#5fb3a3','f-projects':'#c98a6a','f-daily':'#6f9bd1' }; return m[f]||'var(--muted)'; }

  // ---------- render ----------
  statusColor(s){
    const map={ evergreen:['#1f7a4d','rgba(31,122,77,.13)'], budding:['var(--accent-ink)','var(--accent-soft)'], seedling:['#b07b1e','rgba(176,123,30,.14)'], draft:['var(--muted)','var(--code-bg)'], daily:['#2f6db0','rgba(47,109,176,.14)'] };
    return map[s]||map.draft;
  }

  buildTreeRows(){
    const rows=[]; const A=this.state.activeId; const exp=this.state.expanded;
    const baseRow="display:flex;align-items:center;gap:6px;padding:4px 9px;margin:1px 4px;border-radius:7px;cursor:pointer;transition:background .12s;";
    for (const t of this.tree){
      if (t.type==='folder'){
        const open=!!exp[t.id];
        rows.push({ key:t.id, onClick:()=>this.toggleFolder(t.id), rowStyle:baseRow,
          chev:open?'\u25be':'\u25b8', chevStyle:"width:12px;font:400 10px 'IBM Plex Mono';color:var(--muted);text-align:center;",
          dot:'', dotStyle:'display:none;',
          name:t.name, nameStyle:"flex:1;font:600 13px 'IBM Plex Sans';color:var(--ink);letter-spacing:.01em;",
          count:String(t.children.length), countStyle:"font:400 11px 'IBM Plex Mono';color:var(--muted);" });
        if (open){
          for (const cid of t.children){
            const active=cid===A; const n=this.note(cid);
            rows.push({ key:cid, onClick:()=>this.openNote(cid),
              rowStyle:baseRow+"padding-left:30px;"+(active?"background:var(--accent-soft);":""),
              chev:'', chevStyle:'display:none;',
              dot:'', dotStyle:`width:6px;height:6px;border-radius:50%;flex:0 0 6px;background:${active?'var(--accent)':'var(--muted)'};opacity:${active?1:.5};`,
              name:n.title, nameStyle:`flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:${active?500:400} 13px 'IBM Plex Sans';color:${active?'var(--ink)':'var(--ink-soft)'};`,
              count:'', countStyle:'display:none;' });
          }
        }
      } else {
        const active=t.id===A; const n=this.note(t.id);
        rows.push({ key:t.id, onClick:()=>this.openNote(t.id),
          rowStyle:baseRow+(active?"background:var(--accent-soft);":""),
          chev:'', chevStyle:'display:none;',
          dot:'', dotStyle:`width:6px;height:6px;border-radius:50%;flex:0 0 6px;background:${active?'var(--accent)':'var(--muted)'};opacity:${active?1:.5};`,
          name:n.title, nameStyle:`flex:1;font:${active?500:400} 13px 'IBM Plex Sans';color:${active?'var(--ink)':'var(--ink-soft)'};`,
          count:'', countStyle:'display:none;' });
      }
    }
    return rows;
  }

  localGraphData(){
    const A=this.state.activeId; const nb=this.neighbors(A).slice(0,7);
    const cx=130, cy=75, R=52; const nodes=[], edges=[];
    nb.forEach((id,i)=>{ const ang=(i/Math.max(1,nb.length))*Math.PI*2 - Math.PI/2; const x=cx+Math.cos(ang)*R, y=cy+Math.sin(ang)*(R*0.78);
      edges.push({x1:cx,y1:cy,x2:x,y2:y}); nodes.push({x,y,r:4.5,fill:'var(--surface)',stroke:'var(--muted)'}); });
    nodes.push({x:cx,y:cy,r:7,fill:'var(--accent)',stroke:'var(--accent)'});
    return { nodes, edges };
  }

  graphData(){
    const mode=this.state.graphMode||'global'; const A=this.state.activeId; const hover=this.state.graph.hover;
    let pos, ids;
    if(mode==='local'){ const r=this.localLayout(A); pos=r.pos; ids=r.ids; }
    else if(mode==='folder'){ const r=this.folderLayout(); pos=r.pos; ids=r.ids; }
    else { this.ensureLayout(); pos=this._layout.pos; ids=this.allIds(); }
    const idset=new Set(ids);
    const focus = hover ? new Set([hover, ...this.neighbors(hover).filter(x=>idset.has(x))]) : null;
    const edges=this.undirectedEdges().filter(([a,b])=>idset.has(a)&&idset.has(b)&&pos[a]&&pos[b]).map(([a,b])=>{ const inb = focus ? (focus.has(a)&&focus.has(b)) : false;
      return { x1:pos[a].x, y1:pos[a].y, x2:pos[b].x, y2:pos[b].y, w: inb?2:1, o: focus ? (inb?0.55:0.07) : 0.18 }; });
    const nodes=ids.filter(id=>pos[id]).map(id=>{ const p=pos[id]; const deg=this.degree(id); let r=Math.min(20, 6+deg*1.5);
      const active=id===A; const isHover=id===hover; const inF=!focus||focus.has(id);
      let fill, stroke; if(mode==='folder'){ const c=this.folderColorOf(id); fill=c; stroke=c; } else { fill = active||isHover ? 'var(--accent)' : 'var(--surface)'; stroke = active||isHover ? 'var(--accent)' : 'var(--muted)'; }
      r = active ? r+2 : r;
      return { id, x:p.x, y:p.y, r, sw: active?3:2, fill, stroke, opacity: inF?1:0.16, labelY:p.y+r+15, label:this.title(id), textOpacity: inF?(active||isHover?1:0.78):0.12,
        onHover:()=>this.setState(s=>({graph:{...s.graph,hover:id}})), onLeave:()=>this.setState(s=>({graph:{...s.graph,hover:null}})), onClick:()=>{ this.closeGraph(); this.openNote(id); } }; });
    return { edges, nodes };
  }

  renderVals(){
    const A=this.state.activeId; const n=this.note(A); const dark=this.state.theme==='dark';
    const projMeta=this.projects.find(p=>p.id===this.state.project)||this.projects[0];
    const projGlyphStyle=`width:25px;height:25px;border-radius:7px;background:${projMeta.tint};display:flex;align-items:center;justify-content:center;color:#fff;font:600 14px 'Spectral',serif;box-shadow:0 2px 6px -1px var(--accent-soft,rgba(106,124,255,.5));`;
    const projectRows=this.projects.map(p=>{ const active=p.id===this.state.project; return { glyph:p.glyph, name:p.name, desc:p.desc, glyphStyle:`width:32px;height:32px;flex:0 0 32px;border-radius:9px;background:${p.tint};color:#fff;display:flex;align-items:center;justify-content:center;font:600 15px 'Spectral',serif;`, rowStyle:"display:flex;align-items:center;gap:11px;padding:8px 9px;border-radius:9px;cursor:pointer;"+(active?"background:var(--accent-soft);":""), check:active?'\u2713':'', checkStyle:"font:500 13px 'IBM Plex Mono';color:var(--accent-ink);width:16px;flex:0 0 16px;text-align:center;", onClick:()=>this.switchProject(p.id) }; });
    const heroVars={ ...(dark?this.DARK:this.LIGHT), width:'100%', height:'100%', display:'flex', flexDirection:'column', position:'relative', background:'var(--bg)', color:'var(--ink)', fontFamily:"'IBM Plex Sans',sans-serif" };
    const seg=(on)=>({ padding:'4px 13px', borderRadius:'6px', cursor:'pointer', font:"500 12.5px 'IBM Plex Sans'", color: on?'#fff':'var(--ink-soft)', background: on?'var(--accent)':'transparent' });
    const crumbFolder = this.tree.find(t=>t.id===n.folder); const crumb = (crumbFolder?crumbFolder.name+'  /  ':'') + n.title;
    const [sc1,sc2]=this.statusColor(n.status);
    const og=this.outgoingOf(A); const bl=this.backlinksOf(A); const ul=this.unlinkedOf(A);
    const lg=this.localGraphData(); const gd=this.state.graph.open?this.graphData():{edges:[],nodes:[]};
    const lm=this.state.linkMenu; const sm=this.state.slashMenu; const sb=this.state.selBar; const pv=this.state.preview; const bmp=this.blockMenuPlace();
    const layout=this.state.layout||'three'; const pvNote=pv.id?this.note(pv.id):null;
    const palRows=this.paletteData(); const palQ=this.state.palette.q;
    const lkRows=this.linkData(); const slRows=this.slashData();
    const segMini=(on)=>"padding:3px 11px;border-radius:6px;cursor:pointer;font:500 12px 'IBM Plex Sans';color:"+(on?'#fff':'var(--ink-soft)')+";background:"+(on?'var(--accent)':'transparent')+";";
    const iconSeg=(on)=>"width:27px;height:25px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;color:"+(on?'#fff':'var(--muted)')+";background:"+(on?'var(--accent)':'transparent')+";";
    const tabSty=(on)=>"font:"+(on?600:500)+" 12px 'IBM Plex Sans';color:"+(on?'var(--ink)':'var(--muted)')+";cursor:pointer;padding-bottom:11px;margin-bottom:-1px;border-bottom:2px solid "+(on?'var(--accent)':'transparent')+";";
    const og2=og.map(id=>({ title:this.title(id), onClick:()=>this.openNote(id), hover:(e)=>this.showPreview(id,e.currentTarget), leave:()=>this.hidePreview() }));
    const paletteRowStyle=(i)=>"display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:9px;cursor:pointer;"+(i===this.state.paletteIdx?"background:var(--accent-soft);":"");
    const lmRowStyle=(i)=>"display:flex;align-items:center;gap:10px;padding:7px 11px;margin:1px 5px;border-radius:8px;cursor:pointer;"+(i===lm.idx?"background:var(--accent-soft);":"");
    const smRowStyle=(i)=>"display:flex;align-items:center;gap:11px;padding:7px 11px;margin:1px 5px;border-radius:8px;cursor:pointer;"+(i===sm.idx?"background:var(--accent-soft);":"");

    return {
      setHeroRef:this.setHeroRef.bind(this), setEditorRef:this.setEditorRef.bind(this), setPaletteRef:this.setPaletteRef.bind(this),
      heroVars, isDark:dark, isLight:!dark,
      segEditorStyle:seg(!this.state.graph.open), segGraphStyle:seg(this.state.graph.open),
      segEditorClick:()=>this.closeGraph(), segGraphClick:()=>this.openGraph(),
      toggleTheme:this.toggleTheme.bind(this), openGraph:this.openGraph.bind(this), closeGraph:this.closeGraph.bind(this),
      openPalette:this.openPalette.bind(this), closePalette:this.closePalette.bind(this), newNote:this.newNote.bind(this),
      onPaletteInput:this.onPaletteInput.bind(this), onPaletteKey:this.onPaletteKey.bind(this), stop:(e)=>e.stopPropagation(),
      onEditorInput:this.onEditorInput.bind(this), onEditorKeyUp:this.onEditorKeyUp.bind(this), onEditorKeyDown:this.onEditorKeyDown.bind(this), onEditorClick:this.onEditorClick.bind(this), onEditorMouseUp:this.onEditorMouseUp.bind(this), onEditorOver:this.onEditorOver.bind(this), onEditorOut:this.onEditorOut.bind(this),
      setLayThree:()=>this.setLayout('three'), setLayFocus:()=>this.setLayout('focus'), setLayDual:()=>this.setLayout('dual'),
      layThreeStyle:iconSeg(layout==='three'), layFocusStyle:iconSeg(layout==='focus'), layDualStyle:iconSeg(layout==='dual'),
      showSidebar: layout!=='focus', showRight: layout==='three', dual: layout==='dual', markdownSource:this.state.md||'', copyMarkdown:this.copyMarkdown.bind(this), mdCopyLabel:this.state.mdCopied?'Copied ✓':'Copy markdown',

      projName:projMeta.name, projGlyph:projMeta.glyph, projGlyphStyle:projGlyphStyle,
      projectMenu:this.state.projectMenu, toggleProjectMenu:this.toggleProjectMenu.bind(this), closeProjectMenu:this.closeProjectMenu.bind(this), newProject:this.newProject.bind(this), projectRows:projectRows,
      treeRows:this.buildTreeRows(),
      noteCountLabel:this.notes.length+' notes \u00b7 '+this.undirectedEdges().length+' links',

      activeCrumb:crumb, activeTitle:n.title, activeType:n.type,
      activeStatus:n.status, statusStyle:`font:500 11px 'IBM Plex Mono';color:${sc1};background:${sc2};border-radius:6px;padding:2px 9px;text-transform:capitalize;`,
      activePlanted:n.planted, activeUpdated:n.updated, activeTags:n.tags||[],

      outline:this.state.outline.map(o=>({ text:o.text, style:"font:400 13px/1.5 'IBM Plex Sans';color:var(--ink-soft);padding:3px 0;cursor:pointer;", onClick:()=>this.scrollToHeading(o.i) })),
      outgoing:og2, outgoingCount:og.length,
      mentionsTab:this.state.mentionsTab, tabLinked:()=>this.setMentionsTab('linked'), tabUnlinked:()=>this.setMentionsTab('unlinked'), tabLinkedStyle:tabSty(this.state.mentionsTab==='linked'), tabUnlinkedStyle:tabSty(this.state.mentionsTab==='unlinked'), showLinked:this.state.mentionsTab==='linked', showUnlinked:this.state.mentionsTab==='unlinked',
      backlinks:bl.map(id=>({ title:this.title(id), excerpt:this.note(id).excerpt, onClick:()=>this.openNote(id), hover:(e)=>this.showPreview(id,e.currentTarget), leave:()=>this.hidePreview() })), backlinkCount:bl.length, noBacklinks:bl.length===0,
      unlinked:ul.map(id=>({ title:this.title(id), excerpt:this.note(id).excerpt, onClick:()=>this.openNote(id), onLink:(e)=>{ e.stopPropagation(); this.linkMention(id); } })), unlinkedCount:ul.length, noUnlinked:ul.length===0,

      words:this.state.words, readtime:Math.max(1,Math.round(this.state.words/220)), savedLabel:this.state.saved,

      localNodes:lg.nodes, localEdges:lg.edges,

      palette:this.state.palette, paletteRows:palRows.map((r,i)=>({ icon:r.icon, label:r.label, hint:r.hint, iconStyle:`width:22px;text-align:center;font:400 14px 'IBM Plex Mono';color:${r.kind==='cmd'?'var(--accent-ink)':'var(--muted)'};`, rowStyle:paletteRowStyle(i), onClick:r.run, onHover:()=>this.setState({paletteIdx:i}) })),
      paletteEmpty: palRows.length===0 && !!palQ,

      graph:this.state.graph, graphEdges:gd.edges, graphNodes:gd.nodes,
      graphStat:this.notes.length+' notes \u00b7 '+this.undirectedEdges().length+' links',
      graphHoverLabel:this.state.graph.hover?this.title(this.state.graph.hover):'',
      gmGlobal:()=>this.setGraphMode('global'), gmLocal:()=>this.setGraphMode('local'), gmFolder:()=>this.setGraphMode('folder'),
      gmGlobalStyle:segMini((this.state.graphMode||'global')==='global'), gmLocalStyle:segMini(this.state.graphMode==='local'), gmFolderStyle:segMini(this.state.graphMode==='folder'), gmIsFolder:this.state.graphMode==='folder',

      linkMenu:{ open:lm.open, style:`position:absolute;z-index:55;left:${lm.left}px;top:${lm.top}px;width:288px;max-height:${lm.maxH||1000}px;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:11px;box-shadow:0 18px 44px -16px rgba(20,15,5,.5);padding:4px 0 6px;animation:mw-pop .12s ease;` },
      linkRows:lkRows.map((r,i)=>({ title:r.title, sub:r.sub, icon:r.icon, active:i===lm.idx, iconStyle:`width:18px;text-align:center;font:400 13px 'IBM Plex Mono';color:${r.kind==='new'?'var(--accent-ink)':'var(--muted)'};`, rowStyle:lmRowStyle(i), onClick:(e)=>{ e.preventDefault(); r.run(); }, onHover:()=>this.setState(s=>({linkMenu:{...s.linkMenu,idx:i}})) })),
      slashMenu:{ open:sm.open, style:`position:absolute;z-index:55;left:${sm.left}px;top:${sm.top}px;width:228px;max-height:${sm.maxH||1000}px;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:11px;box-shadow:0 18px 44px -16px rgba(20,15,5,.5);padding:4px 0 6px;animation:mw-pop .12s ease;` },
      slashRows:slRows.map((r,i)=>({ label:r.label, hint:r.hint, active:i===sm.idx, rowStyle:smRowStyle(i), onClick:(e)=>{ e.preventDefault(); this.runSlash(r); }, onHover:()=>this.setState(s=>({slashMenu:{...s.slashMenu,idx:i}})) })),
      selBar:{ open:sb.open, fmt:sb.fmt||{}, blockOpen:!!sb.blockOpen, blockMenuUp:bmp.up, blockMenuMaxH:bmp.maxH, style:`position:absolute;z-index:56;left:${sb.left}px;top:${sb.top}px;transform:translateX(-50%);display:flex;align-items:center;gap:1px;background:#211d18;border-radius:9px;padding:4px;box-shadow:0 12px 28px -12px rgba(20,15,5,.7);animation:mw-pop .1s ease;` },
      blockBtnLabel: this.blockShort(sb.blockType||'p'),
      toggleBlockMenu:(e)=>{e.preventDefault();this.toggleBlockMenu();},
      blockItems: this.blockTypeOptions().map(o=>({ type:o.type, label:o.label, hint:o.hint, active:o.type===(sb.blockType||'p'), onClick:(e)=>{e.preventDefault();this.setBlockType(o.type);} })),
      fmtBold:(e)=>{e.preventDefault();this.fmtBold();}, fmtItalic:(e)=>{e.preventDefault();this.fmtItalic();}, fmtCode:(e)=>{e.preventDefault();this.fmtCode();}, fmtLink:(e)=>{e.preventDefault();this.fmtLink();}, fmtHighlight:(e)=>{e.preventDefault();this.fmtHighlight();},
      preview:{ open:pv.open, style:`position:absolute;z-index:52;left:${pv.left}px;top:${pv.top}px;width:300px;background:var(--panel);border:1px solid var(--border);border-radius:11px;box-shadow:0 18px 40px -16px rgba(20,15,5,.5);padding:13px 15px;animation:mw-fade .12s ease;pointer-events:none;` },
      previewTitle:pvNote?pvNote.title:'', previewExcerpt:pvNote?pvNote.excerpt:'', previewType:pvNote?pvNote.type:'', previewStatus:pvNote?pvNote.status:'', previewMeta:pvNote?(this.outgoingOf(pvNote.id).length+' out \u00b7 '+this.backlinksOf(pvNote.id).length+' in'):'',
    };
  }

  render() {
    const v = this.renderVals()
    return (
      <div style={sx('position:fixed;inset:0;overflow:hidden;background:#e7dfcf;')}>
        <div ref={v.setHeroRef} style={sx(v.heroVars)}>

          {/* ===== TOP BAR ===== */}
          <div style={sx("height:50px;flex:0 0 50px;display:flex;align-items:center;gap:12px;padding:0 14px;background:var(--panel,#efe8da);border-bottom:1px solid var(--border,#dcd3c0);position:relative;z-index:5;")}>
            <div style={sx('position:relative;min-width:218px;')}>
              <Hov base={sx('display:flex;align-items:center;gap:9px;cursor:pointer;padding:5px 8px;margin:-5px -8px;border-radius:9px;width:max-content;')} hover={sx('background:var(--accent-soft,rgba(106,124,255,.14));')} onClick={v.toggleProjectMenu}>
                <div style={sx(v.projGlyphStyle)}>{v.projGlyph}</div>
                <div style={sx("font:600 14px 'IBM Plex Sans',sans-serif;color:var(--ink,#2c2823);white-space:nowrap;")}>{v.projName}</div>
                <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted,#9a917f);flex:0 0 auto;")}>▾</span>
              </Hov>
            </div>
            <Hov base={sx("flex:1;max-width:430px;margin:0 auto;height:32px;display:flex;align-items:center;gap:9px;padding:0 10px 0 11px;background:var(--surface,#faf6ee);border:1px solid var(--border,#dcd3c0);border-radius:8px;cursor:text;color:var(--muted,#9a917f);")} hover={sx('border-color:var(--accent,#6a7cff);')} onClick={v.openPalette}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.2" stroke="currentColor" strokeWidth="1.4" /><line x1="9.2" y1="9.2" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              <span style={sx("flex:1;font:400 13px 'IBM Plex Sans';")}>Search or jump to…</span>
              <span style={sx("font:500 11px 'IBM Plex Mono';background:var(--code-bg,#efe8d9);border:1px solid var(--border,#dcd3c0);border-radius:5px;padding:1px 6px;color:var(--muted,#9a917f);")}>⌘K</span>
            </Hov>
            <div style={sx('display:flex;align-items:center;gap:8px;min-width:300px;justify-content:flex-end;')}>
              <div style={sx('display:flex;background:var(--surface,#faf6ee);border:1px solid var(--border,#dcd3c0);border-radius:8px;padding:2px;gap:1px;')}>
                <div onClick={v.setLayThree} title="Three-pane" style={sx(v.layThreeStyle)}><svg width="15" height="15" viewBox="0 0 16 16"><rect x="1.5" y="3.5" width="3" height="9" rx="1" fill="currentColor" opacity=".55" /><rect x="6" y="3.5" width="4" height="9" rx="1" fill="currentColor" /><rect x="11.5" y="3.5" width="3" height="9" rx="1" fill="currentColor" opacity=".55" /></svg></div>
                <div onClick={v.setLayFocus} title="Focus mode" style={sx(v.layFocusStyle)}><svg width="15" height="15" viewBox="0 0 16 16"><rect x="5" y="3.5" width="6" height="9" rx="1" fill="currentColor" /></svg></div>
                <div onClick={v.setLayDual} title="Dual — rendered + markdown" style={sx(v.layDualStyle)}><svg width="15" height="15" viewBox="0 0 16 16"><rect x="1.8" y="3.5" width="5.4" height="9" rx="1" fill="currentColor" /><rect x="8.8" y="3.5" width="5.4" height="9" rx="1" fill="currentColor" opacity=".55" /></svg></div>
              </div>
              <div style={sx('display:flex;background:var(--surface,#faf6ee);border:1px solid var(--border,#dcd3c0);border-radius:8px;padding:2px;gap:2px;')}>
                <div onClick={v.segEditorClick} style={sx(v.segEditorStyle)}>Editor</div>
                <div onClick={v.segGraphClick} style={sx(v.segGraphStyle)}>Graph</div>
              </div>
              <Hov base={sx('width:32px;height:32px;border-radius:8px;border:1px solid var(--border,#dcd3c0);background:var(--surface,#faf6ee);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink-soft,#4f4a40);')} hover={sx('border-color:var(--accent,#6a7cff);color:var(--accent-ink,#4b53c6);')} onClick={v.toggleTheme} title="Toggle theme">
                {v.isDark && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" /><g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><line x1="8" y1="1.4" x2="8" y2="3" /><line x1="8" y1="13" x2="8" y2="14.6" /><line x1="1.4" y1="8" x2="3" y2="8" /><line x1="13" y1="8" x2="14.6" y2="8" /><line x1="3.4" y1="3.4" x2="4.5" y2="4.5" /><line x1="11.5" y1="11.5" x2="12.6" y2="12.6" /><line x1="12.6" y1="3.4" x2="11.5" y2="4.5" /><line x1="4.5" y1="11.5" x2="3.4" y2="12.6" /></g></svg>
                )}
                {v.isLight && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.2 9.6A5.4 5.4 0 1 1 6.6 2.9 4.3 4.3 0 0 0 13.2 9.6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
                )}
              </Hov>
            </div>
          </div>

          {/* ===== BODY ROW ===== */}
          <div style={sx('flex:1;min-height:0;display:flex;position:relative;')}>

            {/* SIDEBAR */}
            {v.showSidebar && (
              <div className="scroll" style={sx('width:250px;flex:0 0 250px;background:var(--panel,#efe8da);border-right:1px solid var(--border,#dcd3c0);overflow-y:auto;padding:12px 6px 18px;display:flex;flex-direction:column;')}>
                <div style={sx('display:flex;align-items:center;justify-content:space-between;padding:2px 10px 10px;')}>
                  <span style={sx("font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted,#9a917f);")}>Notes</span>
                  <Hov as="span" base={sx("width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted,#9a917f);font:300 18px/1 'IBM Plex Sans';")} hover={sx('background:var(--accent-soft,rgba(106,124,255,.14));color:var(--accent-ink,#4b53c6);')} onClick={v.newNote} title="New note">+</Hov>
                </div>
                {v.treeRows.map((row) => (
                  <Hov key={row.key} base={sx(row.rowStyle)} hover={sx('background:var(--accent-soft,rgba(106,124,255,.14));')} onClick={row.onClick}>
                    <span style={sx(row.chevStyle)}>{row.chev}</span>
                    <span style={sx(row.dotStyle)} />
                    <span style={sx(row.nameStyle)}>{row.name}</span>
                    <span style={sx(row.countStyle)}>{row.count}</span>
                  </Hov>
                ))}
                <div style={sx('flex:1;')} />
                <div style={sx('display:flex;align-items:center;gap:8px;padding:9px 11px 2px;margin-top:10px;border-top:1px solid var(--border,#dcd3c0);')}>
                  <span style={sx('width:7px;height:7px;border-radius:50%;background:#4caf7d;')} />
                  <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>{v.noteCountLabel}</span>
                </div>
              </div>
            )}

            {/* EDITOR */}
            <div style={sx('flex:1;min-width:0;background:var(--surface,#faf6ee);display:flex;flex-direction:column;position:relative;')}>
              <div style={sx('flex:1;min-height:0;display:flex;')}>
                <div className="scroll" style={sx('flex:1;min-width:0;overflow-y:auto;')}>
                  <div style={sx('max-width:720px;margin:0 auto;padding:34px 56px 120px;')}>
                    <div style={sx("font:400 12px 'IBM Plex Mono';color:var(--muted,#9a917f);margin-bottom:18px;display:flex;align-items:center;gap:7px;")}>{v.activeCrumb}</div>
                    <div style={sx("font:600 33px/1.18 'Spectral',serif;letter-spacing:-.014em;color:var(--ink,#2c2823);")}>{v.activeTitle}</div>
                    <div style={sx('display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:14px 0 4px;')}>
                      {v.activeTags.map((tag, i) => (
                        <span key={i} style={sx("font:500 12px 'IBM Plex Mono';color:var(--accent-ink,#4b53c6);background:var(--accent-soft,rgba(106,124,255,.14));border-radius:6px;padding:2px 9px;")}>#{tag}</span>
                      ))}
                      <Hov as="span" base={sx("font:400 12px 'IBM Plex Mono';color:var(--muted,#9a917f);cursor:pointer;padding:2px 4px;")} hover={sx('color:var(--accent-ink,#4b53c6);')}>+ tag</Hov>
                    </div>
                    <div style={sx('height:1px;background:var(--border,#dcd3c0);margin:18px 0 22px;')} />
                    <div data-editor="" contentEditable suppressContentEditableWarning spellCheck={false} ref={v.setEditorRef} onInput={v.onEditorInput} onKeyUp={v.onEditorKeyUp} onKeyDown={v.onEditorKeyDown} onClick={v.onEditorClick} onMouseUp={v.onEditorMouseUp} onMouseOver={v.onEditorOver} onMouseOut={v.onEditorOut} style={sx('min-height:340px;outline:none;')} />
                  </div>
                </div>
                {v.dual && (
                  <div className="scroll" style={sx('flex:1;min-width:0;overflow-y:auto;border-left:1px solid var(--border,#dcd3c0);background:var(--code-bg,#efe8d9);')}>
                    <div style={sx('max-width:720px;margin:0 auto;padding:34px 40px 120px;')}>
                      <div style={sx('display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;')}>
                        <span style={sx("font:500 10px 'IBM Plex Mono';letter-spacing:.09em;text-transform:uppercase;color:var(--muted,#9a917f);")}>Markdown source</span>
                        <Hov as="button" base={sx("font:500 11px 'IBM Plex Mono';color:var(--ink-soft,#4f4a40);background:var(--surface,#faf6ee);border:1px solid var(--border,#dcd3c0);border-radius:7px;padding:3px 10px;cursor:pointer;white-space:nowrap;")} hover={sx('border-color:var(--accent,#6a7cff);color:var(--accent-ink,#4b53c6);')} onClick={v.copyMarkdown}>{v.mdCopyLabel}</Hov>
                      </div>
                      <pre style={sx("font:400 13.5px/1.72 'IBM Plex Mono',monospace;color:var(--ink-soft,#4f4a40);white-space:pre-wrap;word-break:break-word;margin:0;")}>{v.markdownSource}</pre>
                    </div>
                  </div>
                )}
              </div>
              <div style={sx("flex:0 0 30px;height:30px;display:flex;align-items:center;gap:16px;padding:0 18px;border-top:1px solid var(--border,#dcd3c0);background:var(--panel,#efe8da);font:400 11px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>
                <span>{v.words} words</span>
                <span>{v.readtime} min read</span>
                <span style={sx('flex:1;')} />
                <span style={sx('display:flex;align-items:center;gap:6px;')}><span style={sx('width:6px;height:6px;border-radius:50%;background:#4caf7d;')} />{v.savedLabel}</span>
              </div>
            </div>

            {/* RIGHT METADATA PANEL */}
            {v.showRight && (
              <div className="scroll" style={sx('width:300px;flex:0 0 300px;background:var(--panel,#efe8da);border-left:1px solid var(--border,#dcd3c0);overflow-y:auto;padding:18px 17px 28px;')}>
                <div style={sx("font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted,#9a917f);margin-bottom:13px;")}>Properties</div>
                <div style={sx('display:flex;flex-direction:column;gap:11px;')}>
                  <div style={sx('display:flex;align-items:center;gap:10px;')}><span style={sx("width:74px;flex:0 0 74px;font:400 12px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>type</span><span style={sx("font:500 13px 'IBM Plex Sans';color:var(--ink,#2c2823);")}>{v.activeType}</span></div>
                  <div style={sx('display:flex;align-items:center;gap:10px;')}><span style={sx("width:74px;flex:0 0 74px;font:400 12px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>status</span><span style={sx(v.statusStyle)}>{v.activeStatus}</span></div>
                  <div style={sx('display:flex;align-items:center;gap:10px;')}><span style={sx("width:74px;flex:0 0 74px;font:400 12px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>planted</span><span style={sx("font:400 13px 'IBM Plex Mono';color:var(--ink-soft,#4f4a40);")}>{v.activePlanted}</span></div>
                  <div style={sx('display:flex;align-items:center;gap:10px;')}><span style={sx("width:74px;flex:0 0 74px;font:400 12px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>updated</span><span style={sx("font:400 13px 'IBM Plex Mono';color:var(--ink-soft,#4f4a40);")}>{v.activeUpdated}</span></div>
                </div>

                <div style={sx('height:1px;background:var(--border,#dcd3c0);margin:18px 0;')} />
                <div style={sx("font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted,#9a917f);margin-bottom:11px;")}>On this page</div>
                {v.outline.map((o, i) => (
                  <Hov key={i} base={sx(o.style)} hover={sx('color:var(--accent-ink,#4b53c6);')} onClick={o.onClick}>{o.text}</Hov>
                ))}

                <div style={sx('height:1px;background:var(--border,#dcd3c0);margin:18px 0;')} />
                <div style={sx('display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;')}>
                  <span style={sx("font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted,#9a917f);")}>Links</span>
                  <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>{v.outgoingCount} out · {v.backlinkCount} in</span>
                </div>
                {v.outgoing.map((lk, i) => (
                  <Hov key={i} base={sx('display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;cursor:pointer;')} hover={sx('background:var(--accent-soft,rgba(106,124,255,.14));')} onClick={lk.onClick} onMouseEnter={lk.hover} onMouseLeave={lk.leave}>
                    <span style={sx("color:var(--accent,#6a7cff);font:400 12px 'IBM Plex Mono';")}>→</span>
                    <span style={sx("font:400 13px 'IBM Plex Sans';color:var(--ink-soft,#4f4a40);")}>{lk.title}</span>
                  </Hov>
                ))}

                <div style={sx('height:1px;background:var(--border,#dcd3c0);margin:18px 0;')} />
                <div style={sx('display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--border,#dcd3c0);margin-bottom:13px;')}>
                  <span onClick={v.tabLinked} style={sx(v.tabLinkedStyle)}>Linked · {v.backlinkCount}</span>
                  <span onClick={v.tabUnlinked} style={sx(v.tabUnlinkedStyle)}>Unlinked · {v.unlinkedCount}</span>
                </div>
                {v.showLinked && (
                  <>
                    {v.backlinks.map((bl, i) => (
                      <Hov key={i} base={sx('border:1px solid var(--border,#dcd3c0);border-radius:9px;padding:9px 11px;margin-bottom:8px;cursor:pointer;background:var(--surface,#faf6ee);')} hover={sx('border-color:var(--accent,#6a7cff);')} onClick={bl.onClick} onMouseEnter={bl.hover} onMouseLeave={bl.leave}>
                        <div style={sx("font:500 12.5px 'IBM Plex Sans';color:var(--ink,#2c2823);margin-bottom:3px;")}>{bl.title}</div>
                        <div style={sx("font:400 12px/1.5 'Spectral',serif;color:var(--muted,#9a917f);")}>{bl.excerpt}</div>
                      </Hov>
                    ))}
                    {v.noBacklinks && (
                      <div style={sx("font:400 12.5px/1.5 'Spectral',serif;color:var(--muted,#9a917f);font-style:italic;")}>No notes link here yet — a quiet corner of the vault.</div>
                    )}
                  </>
                )}
                {v.showUnlinked && (
                  <>
                    {v.unlinked.map((um, i) => (
                      <Hov key={i} base={sx('border:1px solid var(--border,#dcd3c0);border-radius:9px;padding:9px 11px;margin-bottom:8px;cursor:pointer;background:var(--surface,#faf6ee);')} hover={sx('border-color:var(--accent,#6a7cff);')} onClick={um.onClick}>
                        <div style={sx('display:flex;align-items:center;justify-content:space-between;gap:8px;')}>
                          <div style={sx("font:500 12.5px 'IBM Plex Sans';color:var(--ink,#2c2823);")}>{um.title}</div>
                          <Hov as="span" base={sx("font:500 10.5px 'IBM Plex Mono';color:var(--accent-ink,#4b53c6);border:1px solid var(--accent,#6a7cff);border-radius:6px;padding:2px 7px;cursor:pointer;flex:0 0 auto;")} hover={sx('background:var(--accent-soft,rgba(106,124,255,.14));')} onClick={um.onLink}>+ link</Hov>
                        </div>
                        <div style={sx("font:400 12px/1.5 'Spectral',serif;color:var(--muted,#9a917f);margin-top:4px;")}>{um.excerpt}</div>
                      </Hov>
                    ))}
                    {v.noUnlinked && (
                      <div style={sx("font:400 12.5px/1.5 'Spectral',serif;color:var(--muted,#9a917f);font-style:italic;")}>No unlinked mentions — every reference is already a link.</div>
                    )}
                  </>
                )}

                <div style={sx('height:1px;background:var(--border,#dcd3c0);margin:18px 0;')} />
                <div style={sx('display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;')}>
                  <span style={sx("font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted,#9a917f);")}>Local graph</span>
                  <Hov as="span" base={sx("font:400 11px 'IBM Plex Sans';color:var(--accent-ink,#4b53c6);cursor:pointer;")} hover={sx('text-decoration:underline;')} onClick={v.openGraph}>Expand →</Hov>
                </div>
                <div onClick={v.openGraph} style={sx('border:1px solid var(--border,#dcd3c0);border-radius:10px;background:var(--surface,#faf6ee);height:150px;cursor:pointer;overflow:hidden;')}>
                  <svg viewBox="0 0 260 150" style={sx('width:100%;height:100%;display:block;')}>
                    {v.localEdges.map((e, i) => (
                      <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="var(--border,#dcd3c0)" strokeWidth="1" />
                    ))}
                    {v.localNodes.map((n, i) => (
                      <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.fill} stroke={n.stroke} strokeWidth="1.5" />
                    ))}
                  </svg>
                </div>
              </div>
            )}

            {/* ===== GRAPH OVERLAY ===== */}
            {v.graph.open && (
              <div style={sx('position:absolute;inset:0;z-index:20;background:var(--bg,#e7dfcf);display:flex;flex-direction:column;animation:mw-fade .18s ease;')}>
                <div style={sx('height:52px;flex:0 0 52px;display:flex;align-items:center;gap:14px;padding:0 18px;border-bottom:1px solid var(--border,#dcd3c0);background:var(--panel,#efe8da);')}>
                  <span style={sx("font:600 14px 'IBM Plex Sans';color:var(--ink,#2c2823);")}>Graph view</span>
                  <span style={sx("font:400 12px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>{v.graphStat}</span>
                  <div style={sx('display:flex;background:var(--surface,#faf6ee);border:1px solid var(--border,#dcd3c0);border-radius:8px;padding:2px;gap:2px;margin-left:4px;')}>
                    <div onClick={v.gmGlobal} style={sx(v.gmGlobalStyle)}>Constellation</div>
                    <div onClick={v.gmLocal} style={sx(v.gmLocalStyle)}>Local</div>
                    <div onClick={v.gmFolder} style={sx(v.gmFolderStyle)}>Folders</div>
                  </div>
                  <span style={sx('flex:1;')} />
                  <span style={sx("font:400 12px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>{v.graphHoverLabel}</span>
                  <Hov base={sx("width:30px;height:30px;border-radius:8px;border:1px solid var(--border,#dcd3c0);background:var(--surface,#faf6ee);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink-soft,#4f4a40);font:300 18px/1 'IBM Plex Sans';")} hover={sx('border-color:var(--accent,#6a7cff);')} onClick={v.closeGraph}>✕</Hov>
                </div>
                <div style={sx('flex:1;min-height:0;position:relative;')}>
                  <svg viewBox="0 0 900 600" preserveAspectRatio="xMidYMid meet" style={sx('width:100%;height:100%;display:block;')}>
                    {v.graphEdges.map((ge, i) => (
                      <line key={i} x1={ge.x1} y1={ge.y1} x2={ge.x2} y2={ge.y2} stroke="var(--ink-soft,#4f4a40)" strokeWidth={ge.w} strokeOpacity={ge.o} />
                    ))}
                    {v.graphNodes.map((gn) => (
                      <g key={gn.id} onMouseEnter={gn.onHover} onMouseLeave={gn.onLeave} onClick={gn.onClick} style={sx('cursor:pointer;')}>
                        <circle cx={gn.x} cy={gn.y} r={gn.r} fill={gn.fill} stroke={gn.stroke} strokeWidth={gn.sw} opacity={gn.opacity} />
                        <text x={gn.x} y={gn.labelY} textAnchor="middle" fill="var(--ink-soft,#4f4a40)" opacity={gn.textOpacity} style={sx("font:500 12px 'IBM Plex Sans';pointer-events:none;")}>{gn.label}</text>
                      </g>
                    ))}
                  </svg>
                  <div style={sx("position:absolute;left:16px;bottom:14px;display:flex;gap:14px;align-items:center;font:400 11px 'IBM Plex Mono';color:var(--muted,#9a917f);background:var(--surface,#faf6ee);border:1px solid var(--border,#dcd3c0);border-radius:9px;padding:8px 13px;")}>
                    <span style={sx('display:flex;align-items:center;gap:6px;')}><span style={sx('width:9px;height:9px;border-radius:50%;background:var(--accent,#6a7cff);')} />current</span>
                    <span style={sx('display:flex;align-items:center;gap:6px;')}><span style={sx('width:9px;height:9px;border-radius:50%;background:var(--surface,#faf6ee);border:1.5px solid var(--muted,#9a917f);')} />note</span>
                    <span>drag canvas · hover to trace · click to open</span>
                  </div>
                  {v.gmIsFolder && (
                    <div style={sx("position:absolute;right:16px;bottom:14px;display:flex;gap:13px;align-items:center;font:400 11px 'IBM Plex Mono';color:var(--muted,#9a917f);background:var(--surface,#faf6ee);border:1px solid var(--border,#dcd3c0);border-radius:9px;padding:8px 13px;")}>
                      <span style={sx('display:flex;align-items:center;gap:5px;')}><span style={sx('width:9px;height:9px;border-radius:50%;background:var(--accent,#6a7cff);')} />Concepts</span>
                      <span style={sx('display:flex;align-items:center;gap:5px;')}><span style={sx('width:9px;height:9px;border-radius:50%;background:#5fb3a3;')} />Sources</span>
                      <span style={sx('display:flex;align-items:center;gap:5px;')}><span style={sx('width:9px;height:9px;border-radius:50%;background:#c98a6a;')} />Projects</span>
                      <span style={sx('display:flex;align-items:center;gap:5px;')}><span style={sx('width:9px;height:9px;border-radius:50%;background:#6f9bd1;')} />Daily</span>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>

          {/* ===== FLOATING EDITOR MENUS ===== */}
          {v.linkMenu.open && (
            <div className="scroll" style={sx(v.linkMenu.style)}>
              <div style={sx("font:500 10px 'IBM Plex Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#9a917f);padding:8px 12px 6px;")}>Link to note</div>
              {v.linkRows.map((lr, i) => (
                <div key={i} ref={lr.active ? scrollIntoNearest : undefined} onMouseDown={lr.onClick} onMouseEnter={lr.onHover} style={sx(lr.rowStyle)}>
                  <span style={sx(lr.iconStyle)}>{lr.icon}</span>
                  <span style={sx("flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 13px 'IBM Plex Sans';color:var(--ink,#2c2823);")}>{lr.title}</span>
                  <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>{lr.sub}</span>
                </div>
              ))}
            </div>
          )}
          {v.slashMenu.open && (
            <div className="scroll" style={sx(v.slashMenu.style)}>
              <div style={sx("font:500 10px 'IBM Plex Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#9a917f);padding:8px 12px 6px;")}>Insert block</div>
              {v.slashRows.map((sr, i) => (
                <div key={i} ref={sr.active ? scrollIntoNearest : undefined} onMouseDown={sr.onClick} onMouseEnter={sr.onHover} style={sx(sr.rowStyle)}>
                  <span style={sx("width:30px;flex:0 0 30px;text-align:center;font:500 12px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>{sr.hint}</span>
                  <span style={sx("flex:1;font:500 13px 'IBM Plex Sans';color:var(--ink,#2c2823);")}>{sr.label}</span>
                </div>
              ))}
            </div>
          )}
          {v.selBar.open && (
            <div ref={(el)=>{this._selBarEl=el;}} style={sx(v.selBar.style)}>
              <Hov as="span" base={sx("font:500 11.5px 'IBM Plex Sans';color:#f4efe6;padding:3px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;" + (v.selBar.blockOpen?'background:rgba(255,255,255,.13);':''))} hover={sx('background:rgba(255,255,255,.13);')} onMouseDown={v.toggleBlockMenu} title="Turn into">{v.blockBtnLabel}<span style={sx('font-size:8px;opacity:.65;')}>{'▾'}</span></Hov>
              <span style={sx('width:1px;height:18px;background:rgba(255,255,255,.15);margin:0 4px;flex:0 0 auto;')} />
              <Hov as="span" base={sx("font:700 14px 'Spectral';color:#f4efe6;padding:3px 10px;border-radius:6px;cursor:pointer;" + (v.selBar.fmt.bold?'background:rgba(168,176,255,.34);color:#fff;':''))} hover={sx('background:rgba(255,255,255,.13);')} onMouseDown={v.fmtBold} title="Bold">B</Hov>
              <Hov as="span" base={sx("font:italic 600 14px 'Spectral';color:#f4efe6;padding:3px 10px;border-radius:6px;cursor:pointer;" + (v.selBar.fmt.italic?'background:rgba(168,176,255,.34);color:#fff;':''))} hover={sx('background:rgba(255,255,255,.13);')} onMouseDown={v.fmtItalic} title="Italic">i</Hov>
              <Hov as="span" base={sx("font:500 11px 'IBM Plex Mono';color:#f4efe6;padding:3px 9px;border-radius:6px;cursor:pointer;" + (v.selBar.fmt.code?'background:rgba(168,176,255,.34);color:#fff;':''))} hover={sx('background:rgba(255,255,255,.13);')} onMouseDown={v.fmtCode} title="Code">{'</>'}</Hov>
              <Hov as="span" base={sx("font:500 12px 'IBM Plex Mono';color:#a8b0ff;padding:3px 9px;border-radius:6px;cursor:pointer;" + (v.selBar.fmt.link?'background:rgba(168,176,255,.34);color:#fff;':''))} hover={sx('background:rgba(255,255,255,.13);')} onMouseDown={v.fmtLink} title="Wiki link">[[ ]]</Hov>
              <span onMouseDown={v.fmtHighlight} title="Highlight" style={sx('width:16px;height:16px;border-radius:4px;background:#fbe27a;margin:0 6px;cursor:pointer;display:inline-block;flex:0 0 auto;' + (v.selBar.fmt.highlight?'box-shadow:0 0 0 2px #f4efe6;':''))} />
              {v.selBar.blockOpen && (
                <div className="scroll" style={sx(`position:absolute;${v.selBar.blockMenuUp?'bottom':'top'}:calc(100% + 7px);left:0;min-width:176px;max-height:${v.selBar.blockMenuMaxH}px;overflow-y:auto;background:#211d18;border-radius:9px;padding:5px;box-shadow:0 16px 32px -12px rgba(20,15,5,.72);display:flex;flex-direction:column;gap:1px;z-index:57;`)}>
                  {v.blockItems.map((bi, i) => (
                    <Hov key={i} as="div" base={sx("display:flex;align-items:center;gap:9px;padding:6px 9px;border-radius:6px;cursor:pointer;font:500 13px 'Spectral';color:#f4efe6;white-space:nowrap;" + (bi.active?'background:rgba(168,176,255,.30);':''))} hover={sx('background:rgba(255,255,255,.10);')} onMouseDown={bi.onClick}>
                      <span style={sx("width:22px;text-align:center;font:500 10.5px 'IBM Plex Mono';color:#b9b3a5;")}>{bi.hint}</span>
                      {bi.label}
                    </Hov>
                  ))}
                </div>
              )}
            </div>
          )}
          {v.preview.open && (
            <div style={sx(v.preview.style)}>
              <div style={sx("font:600 14px 'Spectral',serif;color:var(--ink,#2c2823);")}>{v.previewTitle}</div>
              <div style={sx("font:400 13px/1.55 'Spectral',serif;color:var(--ink-soft,#4f4a40);margin-top:5px;")}>{v.previewExcerpt}</div>
              <div style={sx("display:flex;gap:9px;margin-top:9px;font:400 10.5px 'IBM Plex Mono';color:var(--muted,#9a917f);")}><span>{v.previewType}</span><span>·</span><span>{v.previewStatus}</span><span>·</span><span>{v.previewMeta}</span></div>
            </div>
          )}

          {/* ===== PROJECT SWITCHER ===== */}
          {v.projectMenu && (
            <>
              <div onClick={v.closeProjectMenu} style={sx('position:absolute;inset:0;z-index:40;')} />
              <div style={sx('position:absolute;top:52px;left:13px;z-index:41;width:272px;background:var(--panel);border:1px solid var(--border);border-radius:13px;box-shadow:0 26px 60px -22px rgba(20,15,5,.5);padding:7px;animation:mw-pop .14s ease;')}>
                <div style={sx("font:500 10px 'IBM Plex Mono';letter-spacing:.09em;text-transform:uppercase;color:var(--muted);padding:7px 9px;")}>Projects</div>
                {v.projectRows.map((pr, i) => (
                  <div key={i} onClick={pr.onClick} style={sx(pr.rowStyle)}>
                    <div style={sx(pr.glyphStyle)}>{pr.glyph}</div>
                    <div style={sx('flex:1;min-width:0;')}>
                      <div style={sx("font:600 13px 'IBM Plex Sans';color:var(--ink);")}>{pr.name}</div>
                      <div style={sx("font:400 11.5px 'Spectral',serif;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{pr.desc}</div>
                    </div>
                    <span style={sx(pr.checkStyle)}>{pr.check}</span>
                  </div>
                ))}
                <div style={sx('height:1px;background:var(--border);margin:6px 6px;')} />
                <Hov base={sx('display:flex;align-items:center;gap:11px;padding:8px 9px;border-radius:9px;cursor:pointer;')} hover={sx('background:var(--accent-soft);')} onClick={v.newProject}>
                  <span style={sx("width:32px;height:32px;flex:0 0 32px;border:1px dashed var(--border);border-radius:9px;display:flex;align-items:center;justify-content:center;color:var(--muted);font:300 20px/1 'IBM Plex Sans';")}>+</span>
                  <span style={sx("font:500 13px 'IBM Plex Sans';color:var(--ink-soft);")}>New project</span>
                </Hov>
              </div>
            </>
          )}

          {/* ===== COMMAND PALETTE ===== */}
          {v.palette.open && (
            <div onClick={v.closePalette} style={sx('position:absolute;inset:0;z-index:40;background:rgba(20,15,8,.32);display:flex;align-items:flex-start;justify-content:center;padding-top:96px;animation:mw-fade .14s ease;')}>
              <div onClick={v.stop} style={sx('width:560px;max-width:88%;background:var(--panel,#efe8da);border:1px solid var(--border,#dcd3c0);border-radius:13px;box-shadow:0 30px 70px -20px rgba(20,15,5,.5);overflow:hidden;animation:mw-pop .16s ease;')}>
                <div style={sx('display:flex;align-items:center;gap:11px;padding:14px 16px;border-bottom:1px solid var(--border,#dcd3c0);')}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={sx('color:var(--muted,#9a917f);')}><circle cx="7" cy="7" r="4.8" stroke="currentColor" strokeWidth="1.5" /><line x1="10.6" y1="10.6" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                  <input ref={v.setPaletteRef} value={v.palette.q} onChange={v.onPaletteInput} onKeyDown={v.onPaletteKey} placeholder="Search notes or run a command…" style={sx("flex:1;border:none;background:transparent;outline:none;font:400 16px 'IBM Plex Sans';color:var(--ink,#2c2823);")} />
                  <span style={sx("font:500 11px 'IBM Plex Mono';background:var(--code-bg,#efe8d9);border:1px solid var(--border,#dcd3c0);border-radius:5px;padding:1px 6px;color:var(--muted,#9a917f);")}>esc</span>
                </div>
                <div className="scroll" style={sx('max-height:344px;overflow-y:auto;padding:7px;')}>
                  {v.paletteRows.map((pr, i) => (
                    <div key={i} onMouseDown={pr.onClick} onMouseEnter={pr.onHover} style={sx(pr.rowStyle)}>
                      <span style={sx(pr.iconStyle)}>{pr.icon}</span>
                      <span style={sx("flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 14px 'IBM Plex Sans';color:var(--ink,#2c2823);")}>{pr.label}</span>
                      <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted,#9a917f);")}>{pr.hint}</span>
                    </div>
                  ))}
                  {v.paletteEmpty && (
                    <div style={sx("padding:22px;text-align:center;font:400 14px 'Spectral',serif;font-style:italic;color:var(--muted,#9a917f);")}>No matches. Press Enter to create this note.</div>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    )
  }
}
