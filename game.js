

/* ============================================================
   GAME LOGIC (pure reducer functions)
   ============================================================ */
/* ============================= CARD DATA ============================= */
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const RED_SUITS = ['♥','♦'];

function cardValue(c){
  if(c.rank==='A') return 1;
  if(c.rank==='10') return RED_SUITS.includes(c.suit) ? 0 : 10;
  if(['J','Q','K'].includes(c.rank)) return 10;
  return parseInt(c.rank,10);
}
function isSpecial(c){ return ['J','Q','K'].includes(c.rank); }
function isRedSuit(s){ return RED_SUITS.includes(s); }
function newDeck(){
  const d=[];
  for(const s of SUITS) for(const r of RANKS) d.push({rank:r, suit:s});
  return d;
}
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function genRoomCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
  let s = '';
  for(let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function genUid(){
  return 'u' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
}

/* ============================= ROOM STATE (pure logic) =============================
   All functions below take a `room` object and mutate it in place, then return it.
   They contain zero I/O — this makes them easy to test and safe to run inside a
   Firebase transaction (which may retry the mutator on contention). */

function freshRoom(hostUid, hostName){
  return {
    hostUid,
    phase: 'lobby', // lobby | peek | playing | reveal | roundEnd | gameOver
    round: 0,
    turnOrder: [hostUid],
    currentUid: null,
    deck: [],
    discard: [],
    players: {
      [hostUid]: { name: hostName, hand: [], total: 0, eliminated: false }
    },
    peekedUids: [],
    drawnCard: null,       // {uid, card, source}
    modal: null,
    finishedBy: null,
    roundEnding: false,
    finalTurnsLeft: 0,
    roundResults: null,
    penaltyApplied: null,
    log: [],
    updatedAt: Date.now()
  };
}

function roomPushLog(room, msg){
  room.log = room.log || [];
  room.log.unshift({msg, t: Date.now()});
  if(room.log.length > 40) room.log.length = 40;
}

function roomAddPlayer(room, uid, name){
  if(room.phase !== 'lobby') return { error:'already-started' };
  if(room.players[uid]) return {}; // already in room (re-join)
  if(Object.keys(room.players).length >= 6) return { error:'room-full' };
  room.players[uid] = { name, hand: [], total: 0, eliminated: false };
  room.turnOrder.push(uid);
  return {};
}

function nextAliveUid(room, fromUid){
  const order = room.turnOrder;
  let i = order.indexOf(fromUid);
  for(let k=0;k<order.length;k++){
    i = (i+1) % order.length;
    if(!room.players[order[i]].eliminated) return order[i];
  }
  return fromUid;
}

function roomStartGame(room){
  if(room.phase !== 'lobby') return { error:'already-started' };
  if(room.turnOrder.length < 2) return { error:'need-more-players' };
  room.round = 1;
  if(!room.theme){
    // Chosen once per match by whoever starts it, then synced to everyone
    // in the room via normal room-state updates — visual only, no effect
    // on rules or logic.
    room.theme = (typeof themePref!=='undefined' && themePref!=='random') ? themePref
      : THEME_KEYS[Math.floor(Math.random()*THEME_KEYS.length)];
  }
  return dealNewRound(room);
}

function dealNewRound(room){
  room.deck = shuffle(newDeck());
  room.discard = [];
  room.drawnCard = null;
  room.modal = null;
  room.finishedBy = null;
  room.roundEnding = false;
  room.finalTurnsLeft = 0;
  room.peekedUids = [];
  room.roundResults = null;
  room.turnCount = 0;
  room.penaltyApplied = null;
  room.recentChange = null;
  for(const uid of room.turnOrder){
    const p = room.players[uid];
    if(p.eliminated) continue;
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
  }
  // NOTE: the discard pile intentionally starts EMPTY. The middle area shows
  // nothing until the first player actually discards a card during play —
  // no card is auto-flipped here anymore.
  room.phase = 'peek';
  // Round winner starts next round; fall back to rotation if eliminated or unknown
  let startUid = room.roundWinnerUid;
  if(!startUid || room.players[startUid]?.eliminated){
    const startIdx = (room.round - 1) % room.turnOrder.length;
    startUid = room.turnOrder[startIdx];
  }
  room.currentUid = room.players[startUid].eliminated ? nextAliveUid(room, startUid) : startUid;
  roomPushLog(room, `logDealt:${room.round}`);
  return {};
}

function roomMarkPeeked(room, uid){
  if(room.phase !== 'peek') return {};
  room.peekedUids = room.peekedUids || [];
  if(!room.peekedUids.includes(uid)) room.peekedUids.push(uid);
  const aliveCount = room.turnOrder.filter(u=>!room.players[u].eliminated).length;
  if(room.peekedUids.length >= aliveCount){
    room.phase = 'playing';
    room.timerUid = room.currentUid;
    room.turnStartedAt = Date.now();
  }
  return {};
}

function placeOnDiscard(room, card){
  room.discard.push(card);
}

function reshuffleFromDiscard(room){
  if(room.discard.length <= 1){ room.deck = shuffle(newDeck()); return; }
  const top = room.discard.pop();
  room.deck = shuffle(room.discard);
  room.discard = [top];
}
function drawFreshCard(room){
  if(room.deck.length===0) reshuffleFromDiscard(room);
  return room.deck.pop();
}

function roomDraw(room, uid, source){
  if(room.phase!=='playing' || room.currentUid!==uid || room.drawnCard) return { error:'not-your-turn' };
  let card;
  if(source==='deck'){
    if(room.deck.length===0) reshuffleFromDiscard(room);
    card = room.deck.pop();
  } else {
    if(room.discard.length===0) return { error:'discard-empty' };
    card = room.discard.pop();
  }
  room.drawnCard = { uid, card, source };
  return {};
}

function advanceTurn(room){
  room.turnCount = (room.turnCount||0) + 1;
  room.drawnCard = null;
  room.modal = null;
  if(room.roundEnding){
    room.finalTurnsLeft -= 1;
    if(room.finalTurnsLeft <= 0){
      revealAndScore(room);
      return;
    }
  }
  room.currentUid = nextAliveUid(room, room.currentUid);
  room.timerUid = room.currentUid;
  room.turnStartedAt = Date.now();
}

/* ---- After a player finishes their normal turn action (swap/discard/ability
   resolved, or a burn attempt resolved), they get a 5-second window to decide
   whether to declare "Finished" — instead of clicking a button proactively.
   No response in time (or a "No") just moves play to the next player. ---- */
function offerFinishCheck(room, uid){
  if(room.roundEnding){
    advanceTurn(room);
    return;
  }
  room.modal = { type:'finishCheck' };
  room.finishCheckUid = uid;
  room.finishCheckUntil = Date.now() + 2000;
}
function roomFinishCheckAnswer(room, uid, wantsFinish){
  if(!room.modal || room.modal.type!=='finishCheck' || room.finishCheckUid!==uid) return { error:'invalid' };
  room.modal = null;
  room.finishCheckUid = null;
  room.finishCheckUntil = null;
  if(wantsFinish){
    return roomDeclareFinished(room, uid);
  }
  advanceTurn(room);
  return {};
}

function offerAbilityOrBurn(room, uid, card){
  if(isSpecial(card)){
    room.modal = { type:'askAbility', card };
  } else {
    offerFinishCheck(room, uid);
  }
}

function roomChooseSlot(room, uid, slotIdx){
  if(room.phase!=='playing' || room.currentUid!==uid || !room.drawnCard) return { error:'invalid' };
  const p = room.players[uid];
  const old = p.hand[slotIdx];
  p.hand[slotIdx] = room.drawnCard.card;
  placeOnDiscard(room, old);
  roomPushLog(room, `swap:${uid}:${old.rank}${old.suit}`);
  // Position-only marker: lets everyone see WHICH slot just changed for
  // this player, without ever revealing the new card's rank/suit. Cleared
  // at the start of the next round.
  room.recentChange = { uid, slot: slotIdx, ts: Date.now() };
  room.drawnCard = null;
  offerFinishCheck(room, uid);
  return {};
}
function roomDiscardDrawn(room, uid){
  if(room.phase!=='playing' || room.currentUid!==uid || !room.drawnCard || room.drawnCard.source!=='deck') return { error:'invalid' };
  const card = room.drawnCard.card;
  placeOnDiscard(room, card);
  roomPushLog(room, `discard:${uid}:${card.rank}${card.suit}`);
  room.drawnCard = null;
  offerAbilityOrBurn(room, uid, card);
  return {};
}

function roomAnswerAbility(room, uid, useIt){
  if(!room.modal || room.modal.type!=='askAbility' || room.currentUid!==uid) return { error:'invalid' };
  const card = room.modal.card;
  if(!useIt){
    roomPushLog(room, `declineAbility:${uid}:${card.rank}`);
    offerFinishCheck(room, uid);
    return {};
  }
  if(card.rank==='K'){
    if(room.deck.length<2) reshuffleFromDiscard(room);
    if(room.deck.length<2){ offerFinishCheck(room, uid); return {}; }
    const c1 = room.deck.pop(), c2 = room.deck.pop();
    room.modal = { type:'king', c1, c2 };
  } else if(card.rank==='J'){
    room.modal = { type:'jackOwn' };
  } else if(card.rank==='Q'){
    room.modal = { type:'queenPick' };
  }
  return {};
}

function roomKingChoose(room, uid, which){
  if(!room.modal || room.modal.type!=='king' || room.currentUid!==uid) return { error:'invalid' };
  const { c1, c2 } = room.modal;
  if(which==='none'){
    placeOnDiscard(room, c1); placeOnDiscard(room, c2);
    roomPushLog(room, `kingNone:${uid}`);
    offerFinishCheck(room, uid);
    return {};
  }
  if(which==='both'){
    room.modal = { type:'kingSlotBoth1', c1, c2 };
    return {};
  }
  const keep = which==='c1'? c1 : c2;
  const other = which==='c1'? c2 : c1;
  room.modal = { type:'kingSlot', keep, other };
  return {};
}
function roomKingSlot(room, uid, slotIdx){
  if(!room.modal || room.modal.type!=='kingSlot' || room.currentUid!==uid) return { error:'invalid' };
  const { keep, other } = room.modal;
  const p = room.players[uid];
  const old = p.hand[slotIdx];
  p.hand[slotIdx] = keep;
  placeOnDiscard(room, other);
  placeOnDiscard(room, old);
  roomPushLog(room, `kingSlot:${uid}`);
  offerFinishCheck(room, uid);
  return {};
}
function roomKingSlotBoth1(room, uid, slotIdx){
  if(!room.modal || room.modal.type!=='kingSlotBoth1' || room.currentUid!==uid) return { error:'invalid' };
  const { c1, c2 } = room.modal;
  const p = room.players[uid];
  const old = p.hand[slotIdx];
  p.hand[slotIdx] = c1;
  placeOnDiscard(room, old);
  room.modal = { type:'kingSlotBoth2', c2, usedSlot:slotIdx };
  return {};
}
function roomKingSlotBoth2(room, uid, slotIdx){
  if(!room.modal || room.modal.type!=='kingSlotBoth2' || room.currentUid!==uid) return { error:'invalid' };
  if(slotIdx===room.modal.usedSlot) return { error:'same-slot' };
  const { c2 } = room.modal;
  const p = room.players[uid];
  const old = p.hand[slotIdx];
  p.hand[slotIdx] = c2;
  placeOnDiscard(room, old);
  roomPushLog(room, `kingSlotBoth:${uid}`);
  offerFinishCheck(room, uid);
  return {};
}

function roomJackOwn(room, uid, ownSlot){
  if(!room.modal || room.modal.type!=='jackOwn' || room.currentUid!==uid) return { error:'invalid' };
  room.modal = { type:'jackTarget', ownSlot };
  return {};
}
const JACK_PREVIEW_MS = 3000;
function roomJackTarget(room, uid, targetUid, targetSlot){
  if(!room.modal || room.modal.type!=='jackTarget' || room.currentUid!==uid) return { error:'invalid' };
  const { ownSlot } = room.modal;
  const opp = room.players[targetUid];
  const peekedCard = opp.hand[targetSlot];
  // Balance rule: only the card being TAKEN is revealed (not the swapper's
  // own card too) — a full two-card reveal would make Jack too strong.
  // The reveal is visible only to the swapper: renderModal() already only
  // shows modal content to ROOM.currentUid (see the isMyTurn gate), and
  // ROOM.currentUid is the swapper for the whole duration of this preview,
  // so no other client ever renders this card face — not the victim, not
  // spectators, not other players. Nothing about the card is persisted
  // anywhere else (mem, logs) until after the swap actually happens.
  room.modal = {
    type:'jackPreview',
    ownSlot, targetUid, targetSlot,
    card:{ rank:peekedCard.rank, suit:peekedCard.suit },
    revealUntil: Date.now() + JACK_PREVIEW_MS
  };
  return {};
}
function roomJackConfirmSwap(room, uid){
  if(!room.modal || room.modal.type!=='jackPreview' || room.currentUid!==uid) return { error:'invalid' };
  const { ownSlot, targetUid, targetSlot } = room.modal;
  const p = room.players[uid];
  const opp = room.players[targetUid];
  const tmp = p.hand[ownSlot];
  p.hand[ownSlot] = opp.hand[targetSlot];
  opp.hand[targetSlot] = tmp;
  // The swapper saw this card during the preview, so they legitimately
  // know it now — record it in their own memory. Everyone else's memory
  // of these two slots resets to unknown, since the physical cards moved.
  if(p.mem) p.mem[ownSlot] = { known:true, rank:p.hand[ownSlot].rank, value:cardValue(p.hand[ownSlot]), conf:1 };
  if(opp.mem) opp.mem[targetSlot] = { known:false, rank:null, value:null, conf:0 };
  roomPushLog(room, `jackSwap:${uid}:${targetUid}`);
  // The victim (and everyone else) now gets a position-only marker on the
  // affected slot — same mechanic as a normal draw-and-swap (see
  // roomChooseSlot). This lets the victim SEE that their card at this
  // slot just changed, without ever revealing what it changed to.
  room.recentChange = { uid: targetUid, slot: targetSlot, ts: Date.now() };
  room.modal = {
    type:'swapDone',
    withName: opp.name,
    swapperName: p.name,
    victimUid: targetUid,
    victimSlot: targetSlot
  };
  return {};
}
function roomSwapDoneAck(room, uid){
  if(!room.modal || room.modal.type!=='swapDone' || room.currentUid!==uid) return { error:'invalid' };
  offerFinishCheck(room, uid);
  return {};
}

function roomQueenPeek(room, uid, slotIdx){
  if(!room.modal || room.modal.type!=='queenPick' || room.currentUid!==uid) return { error:'invalid' };
  const p = room.players[uid];
  roomPushLog(room, `queenPeek:${uid}`);
  room.modal = { type:'queenReveal', slotIdx, rank:p.hand[slotIdx].rank, suit:p.hand[slotIdx].suit, value:cardValue(p.hand[slotIdx]) };
  return {};
}
function roomQueenAck(room, uid){
  if(!room.modal || room.modal.type!=='queenReveal' || room.currentUid!==uid) return { error:'invalid' };
  offerFinishCheck(room, uid);
  return {};
}

/* ---- Burn: on your own turn, instead of drawing, press Burn then select
   as many cards as you want from your hand. All selected cards are checked
   at once against the current discard top. Any that match are removed; any
   that don't each add 2 penalty cards. Uses up your whole turn. ---- */
function roomAttemptBurn(room, uid, slots){
  if(room.phase!=='playing' || room.currentUid!==uid || room.drawnCard) return { error:'invalid' };
  if(room.discard.length===0) return { error:'no-discard' };
  if(!slots || slots.length===0) return { error:'no-slots' };
  const p = room.players[uid];
  const targetRank = room.discard[room.discard.length-1].rank;
  // ALL selected cards must match — if any is wrong, nothing burns, +2 penalty
  const allMatch = slots.every(i => p.hand[i] && p.hand[i].rank===targetRank);
  if(allMatch){
    const sortedSlots = [...slots].sort((a,b)=>b-a);
    for(const slotIdx of sortedSlots){
      const card = p.hand[slotIdx];
      room.discard.pop();
      p.hand.splice(slotIdx,1);
      if(p.mem) p.mem.splice(slotIdx,1);
      placeOnDiscard(room, card);
      roomPushLog(room, `burnSuccess:${uid}:${card.rank}:${p.hand.length}`);
    }
  } else {
    const c1 = drawFreshCard(room), c2 = drawFreshCard(room);
    p.hand.push(c1, c2);
    if(p.mem) p.mem.push({known:false,rank:null,value:null,conf:0},{known:false,rank:null,value:null,conf:0});
    roomPushLog(room, `burnFail:${uid}`);
  }
  offerFinishCheck(room, uid);
  return {};
}

function roomDeclareFinished(room, uid){
  if(room.phase!=='playing' || room.currentUid!==uid || room.drawnCard || room.roundEnding) return { error:'invalid' };
  room.finishedBy = uid;
  roomPushLog(room, `declare:${uid}`);
  const aliveCount = room.turnOrder.filter(u=>!room.players[u].eliminated).length;
  room.roundEnding = true;
  room.finalTurnsLeft = aliveCount - 1;
  if(room.finalTurnsLeft<=0){ revealAndScore(room); return {}; }
  room.currentUid = nextAliveUid(room, room.currentUid);
  room.timerUid = room.currentUid;
  room.turnStartedAt = Date.now();
  return {};
}

function revealAndScore(room){
  room.timerUid = null;
  room.turnStartedAt = null;
  room.phase = 'reveal';
  const aliveUids = room.turnOrder.filter(u=>!room.players[u].eliminated);
  const scores = aliveUids.map(uid=>({ uid, score: room.players[uid].hand.reduce((s,c)=>s+cardValue(c),0) }));
  let penaltyApplied = null;
  for(const s of scores){
    let roundScore = s.score;
    if(room.finishedBy!==null && s.uid===room.finishedBy){
      const strictlyLowest = scores.filter(x=>x.score<s.score).length===0 && scores.filter(x=>x.score===s.score).length===1;
      if(!strictlyLowest){ roundScore = roundScore*2; penaltyApplied = room.players[s.uid].name; }
    }
    s.roundScore = roundScore;
  }
  // Whoever has the lowest raw hand this round wins it outright and scores 0,
  // regardless of who declared Finished (ties all score 0).
  const minScore = Math.min(...scores.map(s=>s.score));
  const roundWinnerNames = [];
  let roundWinnerUid = null;
  for(const s of scores){
    if(s.score===minScore){
      s.roundScore = 0;
      roundWinnerNames.push(room.players[s.uid].name);
      if(!roundWinnerUid) roundWinnerUid = s.uid; // first winner (tiebreak: turnOrder)
    }
  }
  for(const s of scores){
    room.players[s.uid].total += s.roundScore;
    s.name = room.players[s.uid].name;
    s.hand = room.players[s.uid].hand;
  }
  room.roundResults = scores;
  room.penaltyApplied = penaltyApplied;
  room.roundWinnerName = roundWinnerNames.join(', ');
  room.roundWinnerUid = roundWinnerUid; // used to set first player next round
  for(const uid of room.turnOrder){
    if(!room.players[uid].eliminated && room.players[uid].total>=100) room.players[uid].eliminated = true;
  }
  room.phase = 'roundEnd';
  roomPushLog(room, `scored:${room.round}`);
}

function roomNextRound(room){
  if(room.phase!=='roundEnd') return { error:'invalid' };
  const stillAlive = room.turnOrder.filter(u=>!room.players[u].eliminated);
  if(stillAlive.length<=1){ room.phase='gameOver'; return {}; }
  room.round += 1;
  return dealNewRound(room);
}

if(typeof module !== 'undefined'){
  module.exports = {
    cardValue, isSpecial, isRedSuit, newDeck, shuffle, genRoomCode, genUid,
    freshRoom, roomAddPlayer, roomStartGame, dealNewRound, roomMarkPeeked,
    roomDraw, roomChooseSlot, roomDiscardDrawn,
    roomAnswerAbility, roomKingChoose, roomKingSlot, roomKingSlotBoth1, roomKingSlotBoth2,
    roomJackOwn, roomJackTarget,
    roomSwapDoneAck, roomQueenPeek, roomQueenAck, roomAttemptBurn,
    roomDeclareFinished, roomFinishCheckAnswer, revealAndScore, roomNextRound,
    advanceTurn, nextAliveUid
  };
}

/* ============================================================
   UI, NETWORKING, AND APP LAYER
   ============================================================ */
/* ============================= FIREBASE CONFIG =============================
   Paste your Firebase project's config object here. See SETUP.md for how
   to get this from the Firebase console (Project Settings → Your apps). */
const firebaseConfig = {
  apiKey: "AIzaSyA7PV0FBpvQUAHaqFCjmV20S8P2PG-bF_I",
  authDomain: "myapp-80173.firebaseapp.com",
  databaseURL: "https://myapp-80173.firebaseio.com",
  projectId: "myapp-80173",
  storageBucket: "myapp-80173.firebasestorage.app",
  messagingSenderId: "829673467316",
  appId: "1:829673467316:web:88c998e216cbaf437b56e1"
};

/* ============================= MONETIZATION CONFIG =============================
   Set your Ko-fi / Buy Me a Coffee page URL here once you've created one
   (https://ko-fi.com or https://buymeacoffee.com — both free to sign up). */
const DONATE_URL = "https://paypal.me/KhalidBahlool1";
// Link shown/spoken in the promo video's end card — used for the "Play Now"
// button on the post-trailer overlay. Double-check this matches exactly
// what's shown in your video before relying on it.
const TRAILER_PLAY_URL = "game.html";

let fbApp = null, db = null, fbReady = false, fbError = null;
try{
  if(firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('PASTE_')){
    fbApp = firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    fbReady = true;
  }
}catch(e){ fbError = e.message; }

/* ============================= LOCAL IDENTITY ============================= */
function safeStorageGet(key){
  try{ return localStorage.getItem(key); }catch(e){ return MEM_STORE[key] || null; }
}
function safeStorageSet(key, val){
  try{ localStorage.setItem(key, val); }catch(e){ MEM_STORE[key] = val; }
}
const MEM_STORE = {};

let myUid = safeStorageGet('zhaimer_uid');
if(!myUid){ myUid = genUid(); safeStorageSet('zhaimer_uid', myUid); }
let myName = safeStorageGet('zhaimer_name') || '';

/* ============================= APP STATE (local, non-room) ============================= */
let LANG = safeStorageGet('zhaimer_lang') || 'en';

/* ============================= THEME SYSTEM =============================
   Visual-only. Never touches game rules, mechanics, or logic — only swaps
   CSS custom properties + a data-theme attribute on <html>. To add a new
   theme later: add its key to THEME_DEFS below and matching CSS rules
   under [data-theme="yourkey"] in style.css. Nothing else needs to change. */
const THEME_DEFS = {
  memory:  { key:'memory',  labelEn:'Memory Lab',       labelAr:'مختبر الذاكرة',   icon:'🧠' },
  agent:   { key:'agent',   labelEn:'Secret Agent',     labelAr:'العميل السري',    icon:'🕵️' },
  holo:    { key:'holo',    labelEn:'Holographic Table',labelAr:'الطاولة الهولوغرامية', icon:'🔮' },
  living:  { key:'living',  labelEn:'Living Table',     labelAr:'الطاولة الحية',   icon:'🌿' },
};
const THEME_KEYS = Object.keys(THEME_DEFS);

// Preference is 'random' or one of THEME_KEYS — persisted across sessions
let themePref = safeStorageGet('zhaimer_theme_pref') || 'random';
// The actual theme currently applied. For 'random', a new one is rolled
// each time a new match starts (see rollThemeForNewMatch()); for a fixed
// choice it just stays put.
let currentTheme = safeStorageGet('zhaimer_theme_current') || THEME_KEYS[Math.floor(Math.random()*THEME_KEYS.length)];

function setThemePref(pref){
  themePref = pref;
  safeStorageSet('zhaimer_theme_pref', pref);
  if(pref !== 'random'){
    currentTheme = pref;
    safeStorageSet('zhaimer_theme_current', currentTheme);
  } else {
    rollThemeForNewMatch();
  }
  applyTheme();
  render();
}
// Call this whenever a brand-new match/game begins (not each round —
// once per match keeps the experience coherent from start to finish).
function rollThemeForNewMatch(){
  if(themePref === 'random'){
    currentTheme = THEME_KEYS[Math.floor(Math.random()*THEME_KEYS.length)];
    safeStorageSet('zhaimer_theme_current', currentTheme);
  }
  // if themePref is a fixed choice, currentTheme already equals it — no-op
  applyTheme();
}
function applyTheme(){
  const active = (typeof ROOM!=='undefined' && ROOM && ROOM.theme) ? ROOM.theme : currentTheme;
  document.documentElement.setAttribute('data-theme', active);
}
// Note: NOT calling applyTheme() here — ROOM is declared later in this file
// with `let`, and referencing it before that line executes would throw.
// It's called once immediately after ROOM's declaration instead (search
// "INITIAL THEME APPLY" below), and on every render() after that.

/* ============================= SOUND SYSTEM =============================
   Synthesized with the Web Audio API — no sound files needed, so the game
   stays lightweight. Replace with real files in assets/sounds/ later by
   swapping playTone() calls for an <audio> player if you want richer sound. */
let soundOn = safeStorageGet('zhaimer_sound') !== 'off';
let audioCtx = null;
function ensureAudioCtx(){
  if(!audioCtx){
    try{ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){}
  }
  return audioCtx;
}
function playTone(freq, durationMs, type){
  if(!soundOn) return;
  const ctx = ensureAudioCtx();
  if(!ctx) return;
  try{
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs/1000);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + durationMs/1000);
  }catch(e){}
}
function sfxClick(){ playTone(520, 70, 'square'); }
function sfxCard(){ playTone(340, 90, 'triangle'); }
function sfxSuccess(){ playTone(660, 120, 'sine'); setTimeout(()=>playTone(880,150,'sine'), 90); }
function sfxFail(){ playTone(180, 220, 'sawtooth'); }
function sfxWin(){ [660,784,988,1318].forEach((f,i)=>setTimeout(()=>playTone(f,180,'sine'), i*110)); }
function toggleSound(){
  soundOn = !soundOn;
  safeStorageSet('zhaimer_sound', soundOn ? 'on' : 'off');
  if(soundOn) sfxClick();
  render();
}

/* ============================= LOCAL PLAYER STATS =============================
   Stored entirely in localStorage — no account or backend needed. Tracks
   this browser's play history for the local leaderboard page. */
/* ============================= GLOBAL PLAY COUNTER =============================
   A simple cross-visitor "how many games have started" counter, plus a
   "how many distinct people have played" count, stored in Firebase so it's
   not limited to one browser like the local stats above. Since there are no
   accounts, "a person" here means "a distinct browser" (myUid, persisted in
   localStorage) — a reasonable approximation, not a precise headcount.
   Fails silently if Firebase isn't configured — never blocks gameplay. */
function incrementGamesStarted(mode){
  if(!fbReady || !db) return;
  try{
    db.ref('meta/gamesStarted').transaction(cur=>(cur||0)+1);
    db.ref('meta/gamesStartedByMode/'+mode).transaction(cur=>(cur||0)+1);
    db.ref('meta/uniquePlayers/'+myUid).set(true);
  }catch(e){}
}

/* ---- Public-facing "X people have played" badge shown on the landing page.
   Fetched once and cached; harmless if Firebase isn't configured (just
   stays hidden). ---- */
let publicPlayerCount = null;
let publicPlayerCountFetched = false;
function fetchPublicPlayerCount(){
  if(!fbReady || !db || publicPlayerCountFetched) return;
  publicPlayerCountFetched = true;
  db.ref('meta/uniquePlayers').once('value')
    .then(snap => {
      const val = snap.val();
      publicPlayerCount = val ? Object.keys(val).length : 0;
      render();
    })
    .catch(()=>{});
}
function renderPublicPlayerCount(){
  if(!fbReady) return '';
  if(publicPlayerCount===null){ fetchPublicPlayerCount(); return ''; }
  return `<div class="small-note" style="text-align:center;margin:6px 0 2px;">🎮 ${t('playerCountMsg', publicPlayerCount)}</div>`;
}

function loadStats(){
  try{
    const raw = safeStorageGet('zhaimer_stats');
    if(!raw) return { gamesPlayed:0, wins:0, bestScore:null, history:[] };
    return JSON.parse(raw);
  }catch(e){ return { gamesPlayed:0, wins:0, bestScore:null, history:[] }; }
}
function saveStats(stats){ safeStorageSet('zhaimer_stats', JSON.stringify(stats)); }
function recordGameResult(won, finalScore, opponentsCount, mode){
  const stats = loadStats();
  stats.gamesPlayed += 1;
  if(won) stats.wins += 1;
  if(stats.bestScore===null || finalScore < stats.bestScore) stats.bestScore = finalScore;
  stats.history = stats.history || [];
  stats.history.unshift({ name: myName || 'Player', won, score: finalScore, opponents: opponentsCount, mode, date: Date.now() });
  if(stats.history.length > 50) stats.history.length = 50;
  saveStats(stats);
}

let VIEW = 'landing'; // landing | nameEntry | lobby-creating | lobby-joining | in-room
let PENDING_MODE = null; // 'create' | 'join'
let JOIN_CODE_INPUT = '';
let ROOM_CODE = null;
let ROOM = null;
applyTheme(); // INITIAL THEME APPLY — safe now that ROOM exists
let gameResultRecorded = false;
let roomRef = null;
let joinError = null;

function normalizeRoom(r){
  if(!r) return r;
  r.deck = r.deck || [];
  r.discard = r.discard || [];
  r.turnOrder = r.turnOrder || [];
  r.log = r.log || [];
  r.peekedUids = r.peekedUids || [];
  r.players = r.players || {};
  for(const uid in r.players){ r.players[uid].hand = r.players[uid].hand || []; }
  return r;
}

function subscribeRoom(code){
  if(roomRef) roomRef.off();
  ROOM_CODE = code;
  roomRef = db.ref('rooms/'+code);
  roomRef.on('value', snap=>{
    const val = snap.val();
    ROOM = val ? normalizeRoom(val) : null;
    if(ROOM) VIEW = 'in-room';
    render();
  });
}

function updateRoom(mutatorFn){
  if(LOCAL_MODE){
    if(!ROOM) return;
    const result = mutatorFn(ROOM) || {};
    if(result.error) return;
    ROOM.updatedAt = Date.now();
    render();
    maybeRunLocalAI();
    return;
  }
  if(!roomRef) return;
  roomRef.transaction(current=>{
    if(current===null || current===undefined) return current;
    normalizeRoom(current);
    const result = mutatorFn(current) || {};
    if(result.error) return undefined; // abort, no change
    current.updatedAt = Date.now();
    return current;
  });
}

/* ============================= LOCAL "VS AI" MODE ============================= */
let LOCAL_MODE = false;
let DIFFICULTY = 'medium';
let NUM_AI = 2;
let processingLocalAI = false;
const AI_NAMES = ['Hasan','Ali','Yousef','Omar','Sultan'];

async function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }

function believedValue(p, slot){
  const m = p.mem[slot];
  if(m && m.known && m.conf>=0.3) return m.value;
  return 6;
}
function believedTotal(p){
  return p.hand.map((_,i)=>believedValue(p,i)).reduce((s,v)=>s+v,0);
}
function decayConfidence(p){
  const rate = DIFFICULTY==='easy'?0.16 : DIFFICULTY==='hard'?0.04 : 0.09;
  for(const m of p.mem){ if(m.known){ m.conf = Math.max(0, m.conf-rate); if(m.conf<0.15) m.known=false; } }
}
function worstSlotFor(p){
  let worst=0, worstVal=-1;
  for(let i=0;i<p.hand.length;i++){
    const v = believedValue(p,i);
    if(v>worstVal){ worstVal=v; worst=i; }
  }
  return {slot:worst, val:worstVal};
}
function shouldAIUseAbility(card, p){
  if(card.rank==='J'){
    const {val:worstVal} = worstSlotFor(p);
    if(worstVal<7) return false; // not worth the risk of exposing/losing a decent card
  }
  if(DIFFICULTY==='easy') return Math.random()<0.35;
  if(DIFFICULTY==='hard') return true;
  return Math.random()<0.7;
}

function startLocalGame(numAI, difficulty){
  LOCAL_MODE = true;
  DIFFICULTY = difficulty;
  const room = freshRoom(myUid, myName || 'You');
  for(let i=0;i<numAI;i++){
    const aiUid = 'ai'+i;
    roomAddPlayer(room, aiUid, AI_NAMES[i]);
    room.players[aiUid].isAI = true;
  }
  ROOM = room;
  ROOM_CODE = null;
  VIEW = 'in-room';
  roomStartGame(room);
  afterDealLocalAI(room);
  incrementGamesStarted('ai');
  render();
  maybeRunLocalAI();
}

function afterDealLocalAI(room){
  for(const uid of room.turnOrder){
    const p = room.players[uid];
    if(p.isAI && !p.eliminated){
      p.mem = p.hand.map(()=>({known:false,rank:null,value:null,conf:0}));
      const idxs = shuffle(p.hand.map((_,i)=>i)).slice(0, Math.min(2,p.hand.length));
      for(const i of idxs){ p.mem[i] = {known:true, rank:p.hand[i].rank, value:cardValue(p.hand[i]), conf:1}; }
      roomMarkPeeked(room, uid);
    }
  }
}

function maybeRunLocalAI(){
  if(!LOCAL_MODE || processingLocalAI) return;
  if(!ROOM || ROOM.phase!=='playing') return;
  const uid = ROOM.currentUid;
  if(!uid || !ROOM.players[uid] || !ROOM.players[uid].isAI) return;
  if(ROOM.modal && ROOM.modal.type==='finishCheck'){
    processingLocalAI = true;
    setTimeout(()=>{ aiAnswerFinishCheck(uid); processingLocalAI=false; maybeRunLocalAI(); }, 500);
    return;
  }
  if(ROOM.modal){
    processingLocalAI = true;
    setTimeout(()=>{ aiResolveAbilityOrBurnLocal(uid, ROOM.modal.card).then(()=>{ processingLocalAI=false; maybeRunLocalAI(); }); }, 500);
    return;
  }
  processingLocalAI = true;
  setTimeout(()=>{ aiTakeTurnLocal(uid).then(()=>{ processingLocalAI=false; maybeRunLocalAI(); }); }, 650);
}

function aiAnswerFinishCheck(uid){
  const room = ROOM;
  const p = room.players[uid];
  const est = believedTotal(p);
  const avgConf = p.mem.reduce((s,m)=>s+(m.known?m.conf:0),0)/Math.max(1,p.hand.length);
  const threshold = DIFFICULTY==='easy'?7 : DIFFICULTY==='hard'?11 : 9;
  const willingness = DIFFICULTY==='easy'?0.4 : DIFFICULTY==='hard'?0.85 : 0.6;
  const wantsFinish = (room.turnCount||0)>=6 && est<=threshold && avgConf>0.45 && Math.random()<willingness;
  roomFinishCheckAnswer(room, uid, wantsFinish);
  render();
}

async function aiTakeTurnLocal(uid){
  const room = ROOM;
  const p = room.players[uid];

  // Burn attempt: collect all slots the AI is confident about matching the discard top
  if(room.discard.length>0){
    const targetRank = room.discard[room.discard.length-1].rank;
    const confThreshold = DIFFICULTY==='hard'?0.5 : DIFFICULTY==='medium'?0.75 : 2;
    const matchSlots = [];
    for(let i=0;i<p.hand.length;i++){
      const m = p.mem[i];
      if(m && m.known && m.rank===targetRank && m.conf>=confThreshold) matchSlots.push(i);
    }
    if(matchSlots.length>0){
      roomAttemptBurn(room, uid, matchSlots);
      render();
      return;
    }
  }

  const discardTop = room.discard[room.discard.length-1];
  const discardVal = discardTop? cardValue(discardTop): 99;
  const {slot:worst, val:worstVal} = worstSlotFor(p);
  const source = (discardTop && discardVal < worstVal-1) ? 'discard' : 'deck';
  roomDraw(room, uid, source);
  render();
  await delay(600);
  await aiHandleDrawnLocal(uid);
}

async function aiHandleDrawnLocal(uid){
  const room = ROOM;
  const p = room.players[uid];
  const drawn = room.drawnCard;
  const card = drawn.card;
  const v = cardValue(card);
  const {slot:worst, val:worstVal} = worstSlotFor(p);
  decayConfidence(p);
  const marginRandom = DIFFICULTY==='easy'? (Math.random()*3-1) : DIFFICULTY==='hard'? 0 : (Math.random()*1.4-0.6);
  const wantsToKeep = v < (worstVal + marginRandom);

  if(drawn.source==='discard' || wantsToKeep){
    roomChooseSlot(room, uid, worst);
    p.mem[worst] = {known:true, rank:card.rank, value:v, conf:1};
    render();
  } else if(isSpecial(card) && shouldAIUseAbility(card, p)){
    roomDiscardDrawn(room, uid);
    render();
    await delay(500);
    await aiResolveAbilityOrBurnLocal(uid);
  } else {
    roomDiscardDrawn(room, uid);
    render();
    await delay(400);
    await aiResolveAbilityOrBurnLocal(uid);
  }
}

async function aiResolveAbilityOrBurnLocal(uid){
  const room = ROOM;
  const p = room.players[uid];
  if(room.modal && room.modal.type==='askAbility'){
    const use = shouldAIUseAbility(room.modal.card, p);
    roomAnswerAbility(room, uid, use);
    render();
    await delay(500);
    await aiResolveAbilityDetailLocal(uid);
  }
}

async function aiResolveAbilityDetailLocal(uid){
  const room = ROOM;
  const p = room.players[uid];
  if(!room.modal) return;
  const type = room.modal.type;
  if(type==='king'){
    const {c1,c2} = room.modal;
    const better = cardValue(c1)<=cardValue(c2)? c1 : c2;
    const worse = better===c1? c2 : c1;
    const {slot:worst, val:worstVal} = worstSlotFor(p);
    let worst2 = -1, worst2Val = -1;
    for(let i=0;i<p.hand.length;i++){
      if(i===worst) continue;
      const v = believedValue(p,i);
      if(v>worst2Val){ worst2Val=v; worst2=i; }
    }
    const bothWorthwhile = worst2>=0 && cardValue(better)<worstVal && cardValue(worse)<worst2Val;
    if(bothWorthwhile){
      roomKingChoose(room, uid, 'both');
      render(); await delay(400);
      if(room.modal && room.modal.type==='kingSlotBoth1'){
        roomKingSlotBoth1(room, uid, worst);
        p.mem[worst] = {known:true, rank:better.rank, value:cardValue(better), conf:1};
        render(); await delay(400);
        if(room.modal && room.modal.type==='kingSlotBoth2'){
          roomKingSlotBoth2(room, uid, worst2);
          p.mem[worst2] = {known:true, rank:worse.rank, value:cardValue(worse), conf:1};
          render(); await delay(400);
        }
      }
    } else if(cardValue(better) < worstVal){
      roomKingChoose(room, uid, better===c1?'c1':'c2');
      render(); await delay(400);
      if(room.modal && room.modal.type==='kingSlot'){
        roomKingSlot(room, uid, worst);
        p.mem[worst] = {known:true, rank:better.rank, value:cardValue(better), conf:1};
        render(); await delay(400);
      }
    } else {
      roomKingChoose(room, uid, 'none');
      render(); await delay(400);
    }
  } else if(type==='jackOwn'){
    const {slot:worst} = worstSlotFor(p);
    const opponents = room.turnOrder.filter(u=>u!==uid && !room.players[u].eliminated && room.players[u].hand.length>0);
    roomJackOwn(room, uid, worst);
    render(); await delay(400);
    if(opponents.length){
      const target = opponents[Math.floor(Math.random()*opponents.length)];
      const tSlot = Math.floor(Math.random()*room.players[target].hand.length);
      roomJackTarget(room, uid, target, tSlot);
      render(); await delay(400);
      // AI doesn't need the human-facing 2s visual preview — it already
      // has the peeked card's info in room.modal at this point (same data
      // a human player would see rendered), so it can act on it immediately.
      if(room.modal && room.modal.type==='jackPreview'){
        roomJackConfirmSwap(room, uid);
        render(); await delay(400);
      }
      if(room.modal && room.modal.type==='swapDone'){ roomSwapDoneAck(room, uid); render(); await delay(300); }
    }
  } else if(type==='queenPick'){
    const unknownIdxs = p.hand.map((_,i)=>i).filter(i=>!(p.mem[i] && p.mem[i].known));
    const target = unknownIdxs.length? unknownIdxs[Math.floor(Math.random()*unknownIdxs.length)] : Math.floor(Math.random()*p.hand.length);
    roomQueenPeek(room, uid, target);
    render(); await delay(400);
    if(room.modal && room.modal.type==='queenReveal'){
      p.mem[target] = {known:true, rank:room.modal.rank, value:room.modal.value, conf:1};
      roomQueenAck(room, uid);
      render(); await delay(300);
    }
  }
}

/* ============================= i18n ============================= */
const I18N = {
  en:{
    title:'ZHAIMER', subtitle:'Online — play with friends', soundBtn:'Toggle sound',
    modeQuestion:'How do you want to play?', playAIBtn:'Play vs AI',
    opponentsLabel:'AI Opponents', difficultyLabel:'Difficulty',
    diff_easy:'Easy', diff_medium:'Medium', diff_hard:'Hard', dealBtn:'Deal the cards',
    timeLeft:'Time left',
    howToPlayBtn:'How to Play', rulesTitle:'How to Play ZHAIMER',
    themeBtn:'Theme', themeRandomLabel:'Random (Default)',
    themeExplain:'Pick a visual style for the table. Random gives every match a different look; a fixed choice stays until you change it. This only changes appearance — the rules are always the same.',
    supportBtn:'Support this project', privacyBtn:'Privacy Policy', termsBtn:'Terms of Service',
    unmuteBtn:'Tap for sound', replayBtn:'▶ Watch again', watchIntroBtn:'Watch intro', playNowBtn:'Play Now',
    trailerDonateText:'Enjoyed the game? Support its development — every bit helps keep Zhaimer growing.',
    playerCountMsg:(n)=>`${n.toLocaleString()} ${n===1?'person has':'people have'} played Zhaimer`,
    privacyTitle:'Privacy Policy',
    privacyBody:`
      <p><i>Last updated: 2026. This is a general template — if this game grows into a serious business, have a lawyer review it for your specific situation.</i></p>
      <h3>What we collect</h3>
      <p>When you play, we store the display name you choose and your in-game data (cards, scores, room membership) using Google Firebase, so the game can sync between players in real time. We don't require an account, email, or password, and we don't knowingly collect data from children.</p>
      <h3>How it's used</h3>
      <p>Game data exists only to run the match you're playing. Room data is visible to anyone who has that room's code — that's how the game syncs between players.</p>
      <h3>Ads and cookies</h3>
      <p>If this site shows ads (e.g. via Google AdSense), the ad provider may use cookies or similar technologies to serve and measure ads. You can control cookies through your browser settings. See Google's own privacy policy for how they handle ad data.</p>
      <h3>Third parties</h3>
      <p>We use Google Firebase (data sync) and, if enabled, Google AdSense (ads) and a donation processor (Ko-fi/Buy Me a Coffee) if you choose to support the project — each has its own privacy policy governing data they handle directly.</p>
      <h3>Your choices</h3>
      <p>Since no account is required, there's no persistent profile to delete — closing your browser or clearing site data ends your session. For questions, contact: <i>labgameskmb@gmail.com</i>.</p>
    `,
    termsTitle:'Terms of Service',
    termsBody:`
      <p class="terms-meta"><i>Last updated: 2026</i></p>

      <h3>1. Acceptance of Terms</h3>
      <p>By accessing or playing Zhaimer ("the Game"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please discontinue use of the Game.</p>

      <h3>2. Description of Service</h3>
      <p>Zhaimer is a browser-based card game provided free of charge for entertainment purposes. The Game is offered "as is" and "as available," without any guarantee of continuous, uninterrupted, or error-free operation.</p>

      <h3>3. Eligibility</h3>
      <p>The Game is intended for general audiences. If you are under the age of majority in your jurisdiction, you should review these terms with a parent or guardian before continued use.</p>

      <h3>4. Acceptable Use</h3>
      <p>When using the Game, you agree not to:</p>
      <ul>
        <li>Harass, abuse, or disrupt the experience of other players;</li>
        <li>Attempt to interfere with, disable, or overburden the Game's infrastructure;</li>
        <li>Exploit bugs, glitches, or unintended behavior in a way that undermines fair play;</li>
        <li>Use automated tools (bots, scripts) to gain an unfair advantage.</li>
      </ul>

      <h3>5. Intellectual Property</h3>
      <p>All content associated with the Game — including but not limited to its source code, design, graphics, audio, and branding — is the property of the developer and is protected by applicable copyright and intellectual property laws. No part of the Game may be copied, modified, or redistributed without prior written permission.</p>

      <h3>6. Donations and Support</h3>
      <p>Any donations made in support of the Game's development are voluntary and non-refundable. Donations do not grant access to additional features, in-game advantages, or any ownership interest in the Game.</p>

      <h3>7. Advertising and Promotional Content</h3>
      <p>The Game may display promotional or advertising content, including video content. This content is presented for informational purposes and does not constitute an endorsement by the developer of any third-party product or service, except where explicitly stated.</p>

      <h3>8. Disclaimer of Warranties</h3>
      <p>The Game is provided without warranties of any kind, whether express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement.</p>

      <h3>9. Limitation of Liability</h3>
      <p>To the fullest extent permitted by applicable law, the developer shall not be liable for any indirect, incidental, or consequential damages arising from your use of, or inability to use, the Game.</p>

      <h3>10. Changes to These Terms</h3>
      <p>These Terms of Service may be updated periodically to reflect changes to the Game or applicable legal requirements. Continued use of the Game following any such update constitutes acceptance of the revised terms.</p>

      <h3>11. Governing Law</h3>
      <p>These terms shall be governed by and construed in accordance with applicable local law, without regard to its conflict of law principles.</p>

      <h3>12. Contact</h3>
      <p>Questions regarding these Terms of Service may be directed to: <i>labgameskmb@gmail.com</i></p>

      <p class="terms-disclaimer"><i>This document is provided as a general template and does not constitute legal advice. Independent legal review is recommended before relying on it for commercial purposes.</i></p>
    `,
    rulesBody:`
      <h3>🎯 The Goal</h3>
      <p>Each round, you're trying to hold the <b>lowest-value hand</b> of hidden cards — without ever fully knowing what's in it. Memory, risk, and a bit of nerve decide who wins each round. The game continues round after round until only one player is left under 100 points.</p>

      <h3>🃏 Setup</h3>
      <p>Everyone gets <b>4 face-down cards</b>. At the start of the round, you get to peek at <b>2 of your own 4 cards</b> for 4 seconds — then they're hidden again. From then on, your memory is all you have; there's no free re-checking.</p>

      <h3>🔢 Card Values</h3>
      <ul>
        <li>Ace = 1</li>
        <li>2–9 = face value</li>
        <li><b>10 of Hearts / Diamonds (red) = 0</b> — a hidden bargain!</li>
        <li><b>10 of Spades / Clubs (black) = 10</b></li>
        <li>Jack, Queen, King = 10 (as scoring cards)</li>
      </ul>

      <h3>🔁 Your Turn</h3>
      <p>On your turn: <b>draw</b> a card, either from the face-down deck (unknown) or the discard pile (its value is already visible to everyone). Then choose:</p>
      <ul>
        <li><b>Swap it in</b> — the card you replace gets discarded face-up</li>
        <li><b>Discard it directly</b> — only allowed if you drew from the deck</li>
      </ul>

      <h3>👑 Special Powers (King, Jack, Queen)</h3>
      <p>If you drew a King, Jack, or Queen from the deck and choose to discard it directly (rather than swapping it into your hand), you may activate its power instead of just discarding it plainly. Swapping a special card away from your hand does <b>not</b> trigger its power — only a fresh draw from the deck can.</p>
      <ul>
        <li><b>King</b> — draw 2 fresh cards. Keep one (swap it into your hand, discard the rest), keep both (swap both into your hand, discarding the two cards they replace), or discard both.</li>
        <li><b>Jack</b> — blind swap: trade one of your own cards for one of an opponent's, without either of you seeing the cards.</li>
        <li><b>Queen</b> — secretly peek at one of your own hidden cards.</li>
      </ul>

      <h3>🔥 Burning</h3>
      <p>On your own turn, instead of drawing, you can press <b>🔥 Burn</b> if you believe you're holding a card matching whatever's currently on top of the discard pile. Pick the card you think matches — guess right and both cards are removed from play, shrinking your hand by one. Guess wrong and you draw <b>2 penalty cards</b> instead. Either way, this uses up your whole turn — play passes to the next player right after.</p>

      <h3>🏁 Declaring "Finished"</h3>
      <p>After you finish your normal turn (draw, swap/discard, use a power, or attempt a burn), you get a <b>5-second window</b> to declare <b>Finished</b> if you believe your hidden total is the lowest. Don't respond in time (or say no), and play just moves on to the next player as usual. Declaring ends the round — everyone else gets exactly one more turn, then all hands are revealed.</p>
      <ul>
        <li>If you were right (strictly lowest) — great, your risk paid off.</li>
        <li>If you were wrong — your score for the round is <b>doubled</b> as a penalty.</li>
      </ul>

      <h3>🏆 Round Winner Bonus</h3>
      <p>Whoever ends up with the truly lowest hand that round — whether they declared or not — scores <b>0 points</b> for it instead of their raw total.</p>

      <h3>⏱ Turn Timer</h3>
      <p>Each player has <b>60 seconds</b> to act on their turn. If time runs out, your turn is auto-completed for you (a safe default action) so the game keeps moving.</p>

      <h3>☠️ Elimination</h3>
      <p>Once a player's running total reaches <b>100 points</b>, they're eliminated. The game continues with everyone else until only one player remains — the winner.</p>
    `,
    createRoomBtn:'Create a Room', joinRoomBtn:'Join a Room',
    yourNameLabel:'Your name', namePlaceholder:'Enter your name',
    roomCodeLabel:'Room code', codePlaceholder:'e.g. K7QXM',
    continueBtn:'Continue', backBtn:'Back',
    roomCodeTitle:'Your room code', shareHint:'Share this code with friends so they can join.',
    copyLinkBtn:'Copy invite link', linkCopied:'Copied!',
    playersInRoom:'Players in room', hostTag:'Host',
    startGameBtn:'Start Game', needMorePlayers:'Need at least 2 players to start',
    waitingForHost:'Waiting for the host to start the game…',
    waitingForPeeks:'Waiting for other players to finish peeking…',
    joinBtn:'Join', joiningErrorFull:'That room is full.',
    joiningErrorStarted:'That game has already started.',
    joiningErrorMissing:'No room found with that code.',
    round:'Round', pts:'pts', theirTurn:'their turn', eliminatedTag:'eliminated', declaredTag:'declared finished',
    deckLabel:'Deck', leftLabel:'left', discardLabel:'Discard', inPileLabel:'in pile',
    you:'You', waitingFor:(n)=>`Waiting for ${n}…`,
    jackVictimTitle:'A card was swapped', jackVictimBody:(slot)=>`One of your cards (position ${slot}) was just swapped by another player using a Jack. You won't see what it became.`,
    peekHint:'Click 2 of your cards above to peek at them for 4 seconds.',
    drawDeckBtn:'Draw from Deck', drawDiscardBtn:'Draw from Discard', declareFinishedBtn:'Declare Finished',
    declareConfirmMsg:(s)=>`Are you sure you're finished? (${s}s)`,
    yesFinishedBtn:'Declare Finished', cancelBtn:'Cancel',
    swapHintDiscard:'Click one of your cards above to swap it in, or discard this card directly.',
    swapHintNo:'Click one of your cards above to swap it in.',
    discardDirectlyBtn:'Discard directly', slotLabel:'Slot',
    valLabel:'val', spectating:"You've been eliminated — spectating the rest of this match.",
    abilityTitle:(r)=>`${r} Power Available`, abilityBody:(r,c)=>`You discarded a ${c}. Use its special ability?`,
    usePowerBtn:'Use Power', discardPlainBtn:'Discard Plainly',
    kingTitle:"King's Power", kingBody:'Two cards drawn. Keep one and discard the rest, or discard both.',
    keepThisBtn:'Keep this', discardBothBtn:'Discard both',
    kingSlotTitle:"Place the King's Card", kingSlotBody:'Click one of your cards below to swap it in.',
    keepBothBtn:'Keep Both',
    kingSlotBoth1Body:'Click a card below to swap in the first one.',
    kingSlotBoth2Body:'Now click a different card to swap in the second one.',
    jackOwnTitle:'Jack — Blind Swap', jackOwnBody:"Click one of your own cards to offer up (you won't see either card).",
    jackTargetTitle:'Jack — Choose a Target', jackTargetBody:"Click an opponent's card to complete the blind swap.",
    jackPreviewTitle:'Jack — Peek', jackPreviewBody:"You get a quick look at this card before it swaps into your hand. Only you can see it — it'll flip face-down again automatically.",
    jackPreviewContinueBtn:'Continue',
    queenPickTitle:"Queen's Glimpse", queenPickBody:'Click one of your own cards to secretly peek at it.',
    burnBtn:'Burn', pickBurnCard:'Tap the cards you want to burn, then confirm.',
    burnConfirmBtn:(n)=>`Burn ${n} card${n>1?'s':''}`,
    quitBtn:'Quit to menu', quitConfirm:'Leave this game and return to the main menu? Your progress in this game will be lost.',
    revealHeading:(r)=>`Round ${r} — Reveal`,
    rawLabel:'raw', penaltyTag:'(penalty)',
    penaltyMsg:(n)=>`${n} declared Finished but did not have the strictly lowest hand — their score was doubled.`,
    successMsg:(n)=>`${n}'s declaration paid off!`,
    roundWinTag:'(round won — scores 0)',
    roundWinnerMsg:(n)=>`${n} had the lowest hand this round and scores 0 for it!`,
    runningTotals:'Running totals',
    nextRoundBtn:'Next Round', seeResultBtn:'See Final Result',
    gameOverHeading:'Game Over', winsLabel:(n)=>`${n} wins`, playAgainBtn:'Back to Menu',
    slotVal:(i,rank,suit,val)=>`Slot ${i}: ${rank}${suit} — value ${val}`,
    aGlimpseTitle:'A Glimpse', queenGlimpseTitle:"Queen's Glimpse",
    swapDoneTitle:'Swap Complete', swapDoneBody:(n)=>`Your card and one of ${n}'s cards have switched places — neither of you saw the other's card.`,
    swapVictimBody:(swapper, slot)=>`⚠️ ${swapper} used the Jack and swapped one of your cards (slot ${slot}) with one of theirs — you didn't see either card.`,
    continueTurn:'Continue', connLost:'Connection lost — trying to reconnect…',
    firebaseMissing:'Firebase isn\u2019t configured yet. Open this file and paste your Firebase project config near the top of the script — see SETUP.md.',
  },
  ar:{
    title:'زهايمر', subtitle:'أونلاين — العب مع أصحابك', soundBtn:'تشغيل/كتم الصوت',
    modeQuestion:'كيف تحب تلعب؟', playAIBtn:'العب ضد الكمبيوتر',
    opponentsLabel:'عدد خصوم الكمبيوتر', difficultyLabel:'مستوى الصعوبة',
    diff_easy:'سهل', diff_medium:'متوسط', diff_hard:'صعب', dealBtn:'وزّع الأوراق',
    timeLeft:'الوقت المتبقي',
    howToPlayBtn:'كيف تلعب', rulesTitle:'كيف تلعب زهايمر',
    themeBtn:'المظهر', themeRandomLabel:'عشوائي (افتراضي)',
    themeExplain:'اختر الطابع البصري للطاولة. الوضع العشوائي يعطي كل مباراة شكلًا مختلفًا؛ الاختيار الثابت يبقى حتى تغيّره. هذا يغيّر المظهر فقط — القواعد تبقى نفسها دائمًا.',
    supportBtn:'ادعم هذا المشروع', privacyBtn:'سياسة الخصوصية', termsBtn:'شروط الاستخدام',
    unmuteBtn:'اضغط للصوت', replayBtn:'▶ شاهد مرة أخرى', watchIntroBtn:'شاهد المقدمة', playNowBtn:'العب الآن',
    trailerDonateText:'استمتعت باللعبة؟ ادعم تطويرها — كل مساهمة تساعد زهايمر على النمو.',
    playerCountMsg:(n)=>`${n.toLocaleString('ar')} شخص لعبوا زايمر`,
    privacyTitle:'سياسة الخصوصية',
    privacyBody:`
      <p><i>آخر تحديث: 2026. هذا نص عام مبدئي — إذا صار المشروع تجاري بشكل جدي، راجعه مع محامي حسب وضعك.</i></p>
      <h3>وش نجمع</h3>
      <p>لما تلعب، نخزّن الاسم اللي تختاره وبيانات اللعبة (الأوراق، النقاط، عضوية الغرفة) باستخدام Google Firebase، عشان اللعبة تتزامن بين اللاعبين لحظيًا. ما نطلب حساب أو إيميل أو كلمة مرور، وما نجمع بيانات من الأطفال عن قصد.</p>
      <h3>كيف تُستخدم</h3>
      <p>بيانات اللعبة موجودة بس عشان تشغيل المباراة اللي تلعبها. بيانات الغرفة تكون مرئية لأي شخص عنده كود الغرفة — هذي هي طريقة تزامن اللعبة بين اللاعبين.</p>
      <h3>الإعلانات وملفات تعريف الارتباط</h3>
      <p>لو الموقع يعرض إعلانات (مثلاً عبر Google AdSense)، مزوّد الإعلانات ممكن يستخدم ملفات تعريف ارتباط لعرض وقياس الإعلانات. تقدر تتحكم فيها من إعدادات متصفحك.</p>
      <h3>أطراف ثالثة</h3>
      <p>نستخدم Google Firebase (للتزامن)، وإذا فُعّلت، Google AdSense (للإعلانات) ومعالج تبرعات (Ko-fi/Buy Me a Coffee) لو اخترت تدعم المشروع — كل وحدة منهم عندها سياسة خصوصية خاصة بها.</p>
      <h3>خياراتك</h3>
      <p>بما إنه ما فيه حساب مطلوب، ما فيه ملف شخصي دائم تحذفه — إغلاق المتصفح أو مسح بيانات الموقع ينهي جلستك. للأسئلة، تواصل: <i>labgameskmb@gmail.com</i>.</p>
    `,
    termsTitle:'شروط الاستخدام',
    termsBody:`
      <p class="terms-meta"><i>آخر تحديث: 2026</i></p>

      <h3>1. القبول بالشروط</h3>
      <p>باستخدامك أو لعبك لزهايمر ("اللعبة")، فإنك توافق على الالتزام بشروط الاستخدام هذه. إذا كنت لا توافق على هذه الشروط، يُرجى التوقف عن استخدام اللعبة.</p>

      <h3>2. وصف الخدمة</h3>
      <p>زهايمر لعبة ورق تعمل عبر المتصفح، مقدَّمة مجانًا لأغراض ترفيهية. تُقدَّم اللعبة "كما هي" و"حسب توفرها"، دون أي ضمان لاستمرارية التشغيل أو خلوّه من الأخطاء.</p>

      <h3>3. الأهلية</h3>
      <p>اللعبة موجهة لعموم المستخدمين. إذا كنت دون سن الرشد القانوني في بلدك، يُنصح بمراجعة هذه الشروط مع أحد الوالدين أو ولي الأمر قبل الاستمرار في الاستخدام.</p>

      <h3>4. الاستخدام المقبول</h3>
      <p>عند استخدام اللعبة، توافق على عدم القيام بما يلي:</p>
      <ul>
        <li>مضايقة أو إساءة معاملة اللاعبين الآخرين أو الإخلال بتجربتهم؛</li>
        <li>محاولة التدخل في البنية التقنية للعبة أو تعطيلها أو إثقالها؛</li>
        <li>استغلال الأخطاء البرمجية أو الثغرات بطريقة تخلّ بمبدأ اللعب العادل؛</li>
        <li>استخدام أدوات آلية (بوتات أو سكربتات) للحصول على ميزة غير عادلة.</li>
      </ul>

      <h3>5. الملكية الفكرية</h3>
      <p>جميع المحتويات المرتبطة باللعبة — بما في ذلك على سبيل المثال لا الحصر الكود المصدري والتصميم والرسوميات والصوت والهوية البصرية — هي ملك للمطوّر ومحمية بموجب قوانين حقوق النشر والملكية الفكرية المعمول بها. لا يجوز نسخ أي جزء من اللعبة أو تعديله أو إعادة توزيعه دون إذن كتابي مسبق.</p>

      <h3>6. التبرعات والدعم</h3>
      <p>أي تبرعات تُقدَّم دعمًا لتطوير اللعبة هي تبرعات طوعية وغير قابلة للاسترداد. لا تمنح التبرعات الوصول إلى ميزات إضافية أو أي أفضلية داخل اللعبة أو أي حصة ملكية فيها.</p>

      <h3>7. المحتوى الإعلاني والترويجي</h3>
      <p>قد تعرض اللعبة محتوى ترويجيًا أو إعلانيًا، بما في ذلك مقاطع فيديو. يُقدَّم هذا المحتوى لأغراض تعريفية ولا يشكّل تأييدًا من المطوّر لأي منتج أو خدمة تابعة لجهة خارجية، إلا إذا نُصّ على ذلك صراحة.</p>

      <h3>8. إخلاء المسؤولية عن الضمانات</h3>
      <p>تُقدَّم اللعبة دون أي ضمانات من أي نوع، صريحة كانت أو ضمنية، بما في ذلك على سبيل المثال لا الحصر ضمانات الملاءمة لغرض معين أو عدم الإخلال بحقوق الغير.</p>

      <h3>9. حدود المسؤولية</h3>
      <p>إلى أقصى حد يسمح به القانون المعمول به، لا يتحمّل المطوّر المسؤولية عن أي أضرار غير مباشرة أو عرضية أو تبعية ناتجة عن استخدامك للعبة أو عدم قدرتك على استخدامها.</p>

      <h3>10. التغييرات على هذه الشروط</h3>
      <p>قد يتم تحديث شروط الاستخدام هذه دوريًا لتعكس التغييرات في اللعبة أو المتطلبات القانونية المعمول بها. استمرارك في استخدام اللعبة بعد أي تحديث يُعد قبولًا بالشروط المعدَّلة.</p>

      <h3>11. القانون الحاكم</h3>
      <p>تخضع هذه الشروط وتُفسَّر وفقًا للقانون المحلي المعمول به، دون اعتبار لتعارض مبادئ القوانين.</p>

      <h3>12. التواصل</h3>
      <p>للاستفسارات المتعلقة بشروط الاستخدام هذه، يُرجى التواصل عبر: <i>labgameskmb@gmail.com</i></p>

      <p class="terms-disclaimer"><i>هذا المستند نموذج عام ولا يشكّل استشارة قانونية. يُنصح بمراجعة قانونية مستقلة قبل الاعتماد عليه لأغراض تجارية.</i></p>
    `,
    rulesBody:`
      <h3>🎯 الهدف من اللعبة</h3>
      <p>في كلِّ جولة، يسعى كلُّ لاعب إلى الاحتفاظ بيدٍ من الأوراق المخفية بأدنى قيمة مجموع ممكنة، دون أن يعرف محتواها الكامل طوال الوقت. الذاكرة والحسابات الدقيقة وقدر من الجرأة هي العوامل التي تحدد الفائز في كلِّ جولة. تستمر اللعبة جولةً بعد جولة حتى لا يتبقى سوى لاعب واحد لم يتجاوز الـ100 نقطة.</p>

      <h3>🃏 التوزيع والبداية</h3>
      <p>يحصل كلُّ لاعب على <b>أربع أوراق مقلوبة</b>. في مطلع الجولة، يُتاح لك الاطلاع على <b>ورقتين فحسب</b> من أوراقك الأربع لمدة أربع ثوانٍ، ثم تعود جميعها مخفيةً. من تلك اللحظة، لا تملك سوى ذاكرتك.</p>

      <h3>🔢 قيم الأوراق</h3>
      <style>
        .mc{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;
            width:32px;height:46px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);
            background:#fff;font-size:11px;font-weight:700;line-height:1.1;
            vertical-align:middle;margin:0 3px;box-shadow:0 1px 4px rgba(0,0,0,0.3);}
        .mc .r{font-size:10px;} .mc .s{font-size:13px;}
        .mc.red{color:#c0392b;} .mc.blk{color:#1a1a2e;}
        .mc.zero{background:linear-gradient(135deg,#fff9e6,#fff3c0);}
      </style>

      <ul>
        <li style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="mc blk"><span class="r">A</span><span class="s">♠</span></span>
          <span class="mc red"><span class="r">A</span><span class="s">♥</span></span>
          الآس = <b>1 نقطة</b>
        </li>
        <li style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="mc blk"><span class="r">2</span><span class="s">♠</span></span>
          <span style="color:var(--muted)">—</span>
          <span class="mc blk"><span class="r">9</span><span class="s">♣</span></span>
          الأوراق من 2 إلى 9 = <b>قيمتها المكتوبة</b>
        </li>
        <li style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="mc red zero"><span class="r">10</span><span class="s">♥</span></span>
          <span class="mc red zero"><span class="r">10</span><span class="s">♦</span></span>
          العشرة الحمراء (♥ ♦) = <b style="color:#27ae60">0 نقطة</b> — قيمة استثنائية!
        </li>
        <li style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="mc blk"><span class="r">10</span><span class="s">♠</span></span>
          <span class="mc blk"><span class="r">10</span><span class="s">♣</span></span>
          العشرة السوداء (♠ ♣) = <b style="color:var(--crimson)">10 نقاط</b>
        </li>
        <li style="margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="mc blk"><span class="r">J</span><span class="s">♠</span></span>
          <span class="mc red"><span class="r">Q</span><span class="s">♥</span></span>
          <span class="mc blk"><span class="r">K</span><span class="s">♣</span></span>
          أوراق <b>J</b> و<b>Q</b> و<b>K</b> = <b>10 نقاط</b> لكلٍّ منها
        </li>
      </ul>

      <h3>🔁 سير الدور</h3>
      <p>في دورك، <b>اسحب</b> ورقة واحدة: إما من المجموعة المقلوبة (مجهولة القيمة) أو من كومة الرمي (قيمتها ظاهرة). ثم اختر:</p>
      <ul>
        <li><b>بدِّلها بإحدى أوراقك</b> — تُرمى الورقة المستبدَلة مكشوفة على كومة الرمي</li>
        <li><b>ارمِها مباشرةً</b> — يُسمح بذلك فقط إذا سحبتها من المجموعة المقلوبة</li>
      </ul>

      <h3>👑 القوى الخاصة</h3>
      <p>إذا سحبت إحدى هذه الأوراق من المجموعة واخترت رميها مباشرةً (لا تبديلها بيدك)، فبإمكانك تفعيل قوتها الخاصة.</p>
      <ul>
        <li style="margin-bottom:10px;display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <span class="mc blk" style="flex-shrink:0"><span class="r">K</span><span class="s">♠</span></span>
          <div><b>K — الملك:</b> اسحب ورقتين إضافيتين، ثم اختر: احتفظ بإحداهما (وارمِ الأخرى)، أو احتفظ بكلتيهما (وارمِ ورقتين من يدك)، أو ارمِهما معاً.</div>
        </li>
        <li style="margin-bottom:10px;display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <span class="mc blk" style="flex-shrink:0"><span class="r">J</span><span class="s">♠</span></span>
          <div><b>J — الولد:</b> مبادلة عمياء — تبادل إحدى أوراقك مع ورقة لدى أحد المنافسين دون أن يرى أيٌّ منكما الورقتين.</div>
        </li>
        <li style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <span class="mc red" style="flex-shrink:0"><span class="r">Q</span><span class="s">♥</span></span>
          <div><b>Q — البنت:</b> اطَّلع سرًّا على إحدى أوراقك المخفية.</div>
        </li>
      </ul>

      <h3>🔥 الحرق</h3>
      <p>في دورك، بدلًا من السحب، يمكنك الضغط على <b>🔥 حرق</b> إذا ظننتَ أن إحدى أوراقك (أو أكثر) تطابق قيمة أعلى ورقة في كومة الرمي. اختر الأوراق التي تريد حرقها، ثم اضغط تأكيد. <b>يجب أن تكون جميع الأوراق المختارة صحيحةً</b>؛ فإن كانت كذلك تُحرق جميعًا وتُزال من اللعب، وإن كانت إحداها خاطئةً لا يُحرق شيء وتُسحب ورقتان عقوبةً. في كلتا الحالتين ينتهي دورك.</p>

      <h3>🏁 إعلان الانتهاء</h3>
      <p>بعد إتمام دورك العادي، تظهر لك لفترة وجيزة فرصة للإعلان عن انتهائك إذا رأيتَ أن مجموع أوراقك هو الأدنى. في حال الإعلان، يحصل كل لاعب آخر على دورٍ أخير يستخدم فيه كامل خياراته قبل كشف الأوراق.</p>
      <ul>
        <li>إن كنتَ فعلًا صاحب أدنى مجموع — فلا عقوبة عليك.</li>
        <li>إن كنتَ مخطئًا — تُضاعَف نقاطك في هذه الجولة.</li>
      </ul>

      <h3>🏆 مكافأة الفائز بالجولة</h3>
      <p>اللاعب الذي يملك فعليًا أدنى مجموع في الجولة — سواء أعلن انتهاءه أم لا — يحصل على <b>صفر نقاط</b> بدلًا من مجموعه الحقيقي. كما يبدأ هو الجولة التالية.</p>

      <h3>⏱ مؤقِّت الدور</h3>
      <p>لكل لاعب <b>60 ثانية</b> لإتمام دوره. عند انقضاء الوقت، يتخذ النظام إجراءً افتراضيًا تلقائيًا حتى تستمر اللعبة.</p>

      <h3>☠️ الإقصاء</h3>
      <p>حين يبلغ مجموع نقاط أي لاعب <b>100 نقطة أو أكثر</b>، يُقصى من اللعبة. تستمر اللعبة بين المتبقين حتى لا يبقى سوى لاعب واحد — وهو الفائز.</p>
    `,
    createRoomBtn:'أنشئ غرفة', joinRoomBtn:'انضم لغرفة',
    yourNameLabel:'اسمك', namePlaceholder:'اكتب اسمك',
    roomCodeLabel:'كود الغرفة', codePlaceholder:'مثلاً K7QXM',
    continueBtn:'متابعة', backBtn:'رجوع',
    roomCodeTitle:'كود غرفتك', shareHint:'شارك هذا الكود مع أصحابك عشان ينضموا.',
    copyLinkBtn:'انسخ رابط الدعوة', linkCopied:'تم النسخ!',
    playersInRoom:'اللاعبين بالغرفة', hostTag:'المضيف',
    startGameBtn:'ابدأ اللعبة', needMorePlayers:'لازم لاعبين اثنين على الأقل عشان تبدأ',
    waitingForHost:'بانتظار المضيف يبدأ اللعبة…',
    waitingForPeeks:'بانتظار بقية اللاعبين ينتهون من النظر لأوراقهم…',
    joinBtn:'انضم', joiningErrorFull:'الغرفة مليانة.',
    joiningErrorStarted:'اللعبة بدأت خلاص.',
    joiningErrorMissing:'ما لقينا غرفة بهذا الكود.',
    round:'الجولة', pts:'نقطة', theirTurn:'دورهم الآن', eliminatedTag:'مُقصى', declaredTag:'أعلن الانتهاء',
    deckLabel:'المجموعة', leftLabel:'متبقٍ', discardLabel:'الأوراق المرمية', inPileLabel:'في الكومة',
    you:'أنت', waitingFor:(n)=>`في انتظار ${n}…`,
    jackVictimTitle:'تم تبديل إحدى أوراقك', jackVictimBody:(slot)=>`قام لاعب آخر بتبديل إحدى أوراقك (الموضع ${slot}) باستخدام الولد. لن ترى ما أصبحت عليه.`,
    peekHint:'انقر على ورقتين من أوراقك أعلاه لتنظر إليهما لمدة 4 ثوانٍ.',
    drawDeckBtn:'اسحب من المجموعة', drawDiscardBtn:'اسحب من الأوراق المرمية', declareFinishedBtn:'أعلن الانتهاء',
    declareConfirmMsg:(s)=>`متأكد إنك خلصت؟ (${s} ثواني)`,
    yesFinishedBtn:'أعلن الانتهاء', cancelBtn:'إلغاء',
    swapHintDiscard:'انقر على إحدى أوراقك أعلاه لتبديلها، أو ارمِ هذه الورقة مباشرة.',
    swapHintNo:'انقر على إحدى أوراقك أعلاه لتبديلها.',
    discardDirectlyBtn:'ارمِ مباشرة', slotLabel:'الخانة',
    valLabel:'القيمة', spectating:'لقد تم إقصاؤك — أنت تشاهد بقية هذه المباراة.',
    abilityTitle:(r)=>`قوة ${r} متاحة`, abilityBody:(r,c)=>`لقد رميت ${c}. هل تريد استخدام قوتها الخاصة؟`,
    usePowerBtn:'استخدم القوة', discardPlainBtn:'ارمِها بلا استخدام',
    kingTitle:'قوة الملك', kingBody:'تم سحب ورقتين. احتفظ بواحدة وارمِ الباقي، أو ارمِ كلتيهما.',
    keepThisBtn:'احتفظ بهذه', discardBothBtn:'ارمِ كلتيهما',
    kingSlotTitle:'ضع ورقة الملك', kingSlotBody:'انقر على إحدى أوراقك أدناه لتبديلها.',
    keepBothBtn:'احتفظ بالاثنتين',
    kingSlotBoth1Body:'انقر على ورقة أدناه لتبديل الورقة الأولى فيها.',
    kingSlotBoth2Body:'دحين انقر على ورقة مختلفة لتبديل الورقة الثانية فيها.',
    jackOwnTitle:'الولد — تبديل أعمى', jackOwnBody:'انقر على إحدى أوراقك لتقديمها (لن ترى أيًا من الورقتين).',
    jackTargetTitle:'الولد — اختر هدفًا', jackTargetBody:'انقر على ورقة أحد الخصوم لإتمام التبديل الأعمى.',
    jackPreviewTitle:'الولد — نظرة سريعة', jackPreviewBody:'ستحصل على نظرة سريعة على هذه الورقة قبل أن تنتقل إلى يدك. أنت وحدك من يراها — وستنقلب لأسفل تلقائيًا بعد ذلك.',
    jackPreviewContinueBtn:'متابعة',
    queenPickTitle:'لمحة الملكة', queenPickBody:'انقر على إحدى أوراقك لتنظر إليها سرًا.',
    burnBtn:'حرق', pickBurnCard:'اضغط على الأوراق اللي تبي تحرقها، وبعدين أكد.',
    burnConfirmBtn:(n)=>`احرق ${n} ${n===1?'ورقة':'أوراق'}`,
    quitBtn:'اخرج للقائمة', quitConfirm:'تبي تطلع من هذي اللعبة وترجع للقائمة الرئيسية؟ تقدمك بهذي اللعبة بيضيع.',
    revealHeading:(r)=>`الجولة ${r} — الكشف`,
    rawLabel:'الأصلي', penaltyTag:'(عقوبة)',
    penaltyMsg:(n)=>`أعلن ${n} الانتهاء لكن لم يكن لديه أقل مجموع بشكل قاطع — تضاعفت نقاطه.`,
    successMsg:(n)=>`نجح إعلان ${n}!`,
    roundWinTag:'(فاز بالجولة — 0 نقطة)',
    roundWinnerMsg:(n)=>`كان لدى ${n} أقل مجموع هذه الجولة، فيحصل على 0 نقطة!`,
    runningTotals:'المجموع التراكمي',
    nextRoundBtn:'الجولة التالية', seeResultBtn:'عرض النتيجة النهائية',
    gameOverHeading:'انتهت المباراة', winsLabel:(n)=>`${n} يفوز`, playAgainBtn:'رجوع للقائمة',
    slotVal:(i,rank,suit,val)=>`الخانة ${i}: ${rank}${suit} — القيمة ${val}`,
    aGlimpseTitle:'لمحة سريعة', queenGlimpseTitle:'لمحة الملكة',
    swapDoneTitle:'تم التبديل', swapDoneBody:(n)=>`تبادلت ورقتك مع إحدى أوراق ${n} — كلاكما لم يرَ ورقة الآخر.`,
    swapVictimBody:(swapper, slot)=>`⚠️ ${swapper} استخدم الولد وبدّل إحدى أوراقك (الخانة ${slot}) مع واحدة من أوراقه — ما أحد شاف أي من الورقتين.`,
    continueTurn:'متابعة', connLost:'انقطع الاتصال — جاري إعادة المحاولة…',
    firebaseMissing:'ما تم إعداد Firebase بعد. افتح هذا الملف وألصق إعدادات مشروع Firebase أعلى الكود — راجع SETUP.md.',
  }
};
function t(key, ...args){
  const dict = I18N[LANG] || I18N.en;
  const v = dict[key] !== undefined ? dict[key] : I18N.en[key];
  return typeof v==='function' ? v(...args) : v;
}
function setLang(l){
  LANG = l;
  safeStorageSet('zhaimer_lang', l);
  document.documentElement.setAttribute('dir', l==='ar' ? 'rtl' : 'ltr');
  document.documentElement.setAttribute('lang', l==='ar' ? 'ar' : 'en');
  render();
}

/* ============================= CARD RENDER HELPERS ============================= */
function renderCardFace(card, extraClass){
  const red = isRedSuit(card.suit);
  return `<div class="card faceUp ${red?'red':''} ${extraClass||''}">
    <div class="rank">${card.rank}</div>
    <div class="suit">${card.suit}</div>
    <div class="valchip">${t('valLabel')} ${cardValue(card)}</div>
  </div>`;
}
function renderCardBack(extraClass, burnt){
  return `<div class="card faceDown ${extraClass||''} ${burnt?'burnt':''}"></div>`;
}
function modalWrap(inner){ return `<div class="overlay"><div class="modal">${inner}</div></div>`; }
function bannerWrap(title, text){ return `<div class="hint-banner"><h3>${title}</h3><p>${text}</p></div>`; }

/* ============================= LOCAL PEEK TIMER (client-side only) ============================= */
let peekSelected = [];
let burnDeclared = false;
let burnSelected = []; // slots selected for multi-burn
function declareBurnAttempt(){ burnDeclared = true; burnSelected = []; render(); }
function cancelBurnAttempt(){ burnDeclared = false; burnSelected = []; render(); }
function toggleBurnSlot(slot){
  if(burnSelected.includes(slot)) burnSelected = burnSelected.filter(s=>s!==slot);
  else burnSelected = [...burnSelected, slot];
  render();
}
function confirmBurn(){
  if(burnSelected.length===0) return;
  const slots = [...burnSelected];
  burnDeclared = false; burnSelected = [];
  const handLenBefore = ROOM.players[myUid].hand.length;
  updateRoom(room=>roomAttemptBurn(room, myUid, slots));
  setTimeout(()=>{
    if(ROOM && ROOM.players[myUid]){
      if(ROOM.players[myUid].hand.length < handLenBefore) sfxSuccess(); else sfxFail();
    }
  }, 60);
}
let peekRevealUntil = null;

function finishCheckSecondsLeft(){
  if(!ROOM || !ROOM.finishCheckUntil) return null;
  return Math.max(0, Math.ceil((ROOM.finishCheckUntil - Date.now())/1000));
}
function actFinishCheckAnswer(wantsFinish){ updateRoom(room=>roomFinishCheckAnswer(room, myUid, wantsFinish)); }

function humanTogglePeek(idx){
  if(!ROOM || ROOM.phase!=='peek') return;
  if(peekSelected.includes(idx)){ peekSelected = peekSelected.filter(i=>i!==idx); render(); return; }
  if(peekSelected.length>=2) return;
  peekSelected.push(idx);
  render();
  if(peekSelected.length===2){
    peekRevealUntil = Date.now()+4000;
    render();
    setTimeout(()=>{
      peekSelected = []; peekRevealUntil = null;
      updateRoom(room=>roomMarkPeeked(room, myUid));
      render();
    }, 4000);
  }
}

/* ============================= LANDING / LOBBY ACTIONS ============================= */
function goCreate(){ PENDING_MODE='create'; VIEW='nameEntry'; render(); }
function goJoin(){ PENDING_MODE='join'; VIEW='nameEntry'; render(); }
function goAISetup(){ VIEW='aiSetup'; render(); }
function preserveAINameField(){
  const el = document.getElementById('aiNameField');
  if(el && el.value!==undefined) myName = el.value;
}
function setNumAIVal(n){ preserveAINameField(); NUM_AI=n; render(); }
function setDifficultyVal(d){ preserveAINameField(); DIFFICULTY=d; render(); }
function submitAISetup(){
  const nameInput = document.getElementById('aiNameField');
  const name = (nameInput ? nameInput.value : myName).trim().slice(0,20) || 'Player';
  myName = name;
  safeStorageSet('zhaimer_name', name);
  startLocalGame(NUM_AI, DIFFICULTY);
}
function goBackToLanding(){ VIEW='landing'; PENDING_MODE=null; joinError=null; render(); }
function goRules(){ VIEW='rules'; render(); }
function goTheme(){ VIEW='theme'; render(); }
function pickTheme(val){ setThemePref(val); }
function goPrivacy(){ VIEW='privacy'; render(); }

/* ============================= LANDING TRAILER (promo video) =============================
   Plays your promo video automatically ONLY the first time a given device
   visits the site (tracked via localStorage, so it's per-device, not
   per-session — closing and reopening the browser won't replay it). Every
   visit after that shows a click-to-play thumbnail instead, and a
   "Watch again" option appears once someone has watched it. When the
   video finishes (either way), it's replaced by a short donate message —
   a simple, non-intrusive way to ask for support right after someone's
   attention is on the game. */
function hasSeenTrailer(){
  return safeStorageGet('zhaimer_trailer_seen') === '1';
}
function markTrailerSeen(){
  safeStorageSet('zhaimer_trailer_seen', '1');
}
function toggleTrailerSound(){
  const v = document.getElementById('zhaimerTrailer');
  const btn = document.getElementById('trailerUnmute');
  if(!v) return;
  v.muted = !v.muted;
  if(btn) btn.textContent = v.muted ? '🔇' : '🔊';
}
function playTrailer(){
  const v = document.getElementById('zhaimerTrailer');
  const overlay = document.getElementById('trailerPlayOverlay');
  if(!v) return;
  if(overlay) overlay.style.display = 'none';
  // A click is a genuine user gesture, so sound is allowed here even
  // though autoplay elsewhere has to start muted.
  v.muted = false;
  v.currentTime = 0;
  v.play().catch(()=>{ v.muted = true; v.play().catch(()=>{}); });
}
function replayTrailer(){
  const v = document.getElementById('zhaimerTrailer');
  const overlay = document.getElementById('trailerDonateOverlay');
  if(!v) return;
  if(overlay) overlay.style.display = 'none';
  v.style.display = '';
  v.muted = false;
  v.currentTime = 0;
  v.play().catch(()=>{ v.muted = true; v.play().catch(()=>{}); });
}
function setupTrailer(){
  const v = document.getElementById('zhaimerTrailer');
  const overlay = document.getElementById('trailerDonateOverlay');
  if(!v || v.dataset.wired) return;
  v.dataset.wired = '1';
  v.addEventListener('play', ()=>{ markTrailerSeen(); });
  v.addEventListener('ended', ()=>{
    markTrailerSeen();
    v.style.display = 'none';
    const unmuteBtn = document.getElementById('trailerUnmute');
    if(unmuteBtn) unmuteBtn.style.display = 'none';
    if(overlay) overlay.style.display = 'flex';
  });
}
function goTerms(){ VIEW='terms'; render(); }

function submitNameEntry(){
  const nameInput = document.getElementById('nameField');
  const name = (nameInput ? nameInput.value : myName).trim().slice(0,20) || 'Player';
  myName = name;
  safeStorageSet('zhaimer_name', name);
  if(PENDING_MODE==='create'){
    const codeInput = document.getElementById('joinCodeField');
    doCreateRoom();
  } else {
    VIEW = 'joinCodeEntry';
    render();
  }
}
function doCreateRoom(){
  if(!fbReady){ render(); return; }
  const code = genRoomCode();
  const room = freshRoom(myUid, myName);
  db.ref('rooms/'+code).set(room).then(()=>{
    subscribeRoom(code);
    VIEW = 'in-room';
    render();
  });
}
function submitJoinCode(){
  const codeInput = document.getElementById('joinCodeField');
  const code = (codeInput ? codeInput.value : '').trim().toUpperCase();
  if(!code){ return; }
  joinError = null;
  attemptJoin(code);
}
function attemptJoin(code){
  if(!fbReady) return;
  const ref = db.ref('rooms/'+code);
  ref.once('value').then(snap=>{
    const val = snap.val();
    if(!val){ joinError = t('joiningErrorMissing'); render(); return; }
    normalizeRoom(val);
    if(val.phase!=='lobby' && !val.players[myUid]){ joinError = t('joiningErrorStarted'); render(); return; }
    if(Object.keys(val.players).length>=6 && !val.players[myUid]){ joinError = t('joiningErrorFull'); render(); return; }
    ref.transaction(current=>{
      if(!current) return current;
      normalizeRoom(current);
      const result = roomAddPlayer(current, myUid, myName);
      if(result.error) return undefined;
      return current;
    }).then(()=>{
      subscribeRoom(code);
      VIEW = 'in-room';
      render();
    });
  });
}

/* auto-join from ?room=CODE in URL */
function checkUrlForRoomCode(){
  const params = new URLSearchParams(window.location.search);
  const code = params.get('room');
  if(code) { JOIN_CODE_INPUT = code.toUpperCase(); }
  return code;
}

/* ============================= IN-GAME ACTIONS ============================= */
function actStartGame(){ updateRoom(room=>roomStartGame(room)); incrementGamesStarted('online'); }
function actDraw(source){ updateRoom(room=>roomDraw(room, myUid, source)); }
function actChooseSlot(slot){ updateRoom(room=>roomChooseSlot(room, myUid, slot)); }
function actDiscardDrawn(){ updateRoom(room=>roomDiscardDrawn(room, myUid)); }
function actAnswerAbility(yes){ updateRoom(room=>roomAnswerAbility(room, myUid, yes)); }
function actKingChoose(which){ updateRoom(room=>roomKingChoose(room, myUid, which)); }
function actKingSlot(slot){ updateRoom(room=>roomKingSlot(room, myUid, slot)); }
function actKingSlotBoth1(slot){ updateRoom(room=>roomKingSlotBoth1(room, myUid, slot)); }
function actKingSlotBoth2(slot){ updateRoom(room=>roomKingSlotBoth2(room, myUid, slot)); }
function actJackOwn(slot){ updateRoom(room=>roomJackOwn(room, myUid, slot)); }
function actJackTarget(targetUid, slot){ updateRoom(room=>roomJackTarget(room, myUid, targetUid, slot)); }
function actJackConfirmSwap(){ updateRoom(room=>roomJackConfirmSwap(room, myUid)); }
function actSwapDoneAck(){ updateRoom(room=>roomSwapDoneAck(room, myUid)); }
function actQueenPeek(slot){ updateRoom(room=>roomQueenPeek(room, myUid, slot)); }
function actQueenAck(){ updateRoom(room=>roomQueenAck(room, myUid)); }
function actAttemptBurn(slot){ burnDeclared = false; burnSelected = []; updateRoom(room=>roomAttemptBurn(room, myUid, [slot])); }
function actNextRound(){
  updateRoom(room=>{
    const result = roomNextRound(room);
    if(!result.error && LOCAL_MODE && room.phase==='peek'){
      afterDealLocalAI(room);
    }
    return result;
  });
}
/* ============================= TURN TIMER ============================= */
const TURN_LIMIT_MS = 60000;
const WATCHDOG_GRACE_MS = 75000; // give the active player's own client first chance before another client steps in

function forceSkipTurn(forUid){
  updateRoom(room=>{
    if(room.currentUid!==forUid) return { error:'stale' };
    if(room.modal){
      const type = room.modal.type;
      const handLen = room.players[forUid].hand.length;
      if(type==='askAbility') return roomAnswerAbility(room, forUid, false);
      if(type==='king') return roomKingChoose(room, forUid, 'none');
      if(type==='kingSlot') return roomKingSlot(room, forUid, Math.floor(Math.random()*handLen));
      if(type==='kingSlotBoth1') return roomKingSlotBoth1(room, forUid, Math.floor(Math.random()*handLen));
      if(type==='kingSlotBoth2'){
        const opts = Array.from({length:handLen},(_, i)=>i).filter(i=>i!==room.modal.usedSlot);
        return roomKingSlotBoth2(room, forUid, opts[Math.floor(Math.random()*opts.length)]);
      }
      if(type==='jackOwn') return roomJackOwn(room, forUid, Math.floor(Math.random()*handLen));
      if(type==='jackTarget'){
        const opts = room.turnOrder.filter(u=>u!==forUid && !room.players[u].eliminated && room.players[u].hand.length>0);
        if(!opts.length){ room.modal=null; offerFinishCheck(room, forUid); return {}; }
        const target = opts[Math.floor(Math.random()*opts.length)];
        return roomJackTarget(room, forUid, target, Math.floor(Math.random()*room.players[target].hand.length));
      }
      if(type==='jackPreview') return roomJackConfirmSwap(room, forUid);
      if(type==='swapDone') return roomSwapDoneAck(room, forUid);
      if(type==='queenPick') return roomQueenPeek(room, forUid, Math.floor(Math.random()*handLen));
      if(type==='queenReveal') return roomQueenAck(room, forUid);
      if(type==='finishCheck') return roomFinishCheckAnswer(room, forUid, false);
      return { error:'unhandled' };
    }
    if(!room.drawnCard){
      return roomDraw(room, forUid, 'deck');
    } else if(room.drawnCard.source==='deck'){
      // Force-discard: don't trigger abilities (player didn't choose this)
      const card = room.drawnCard.card;
      placeOnDiscard(room, card);
      roomPushLog(room, `forceDiscard:${forUid}:${card.rank}${card.suit}`);
      room.drawnCard = null;
      advanceTurn(room);
      return {};
    } else {
      return roomChooseSlot(room, forUid, Math.floor(Math.random()*room.players[forUid].hand.length));
    }
  });
}

function tickTimer(){
  if(ROOM && ROOM.modal && ROOM.modal.type==='finishCheck' && ROOM.finishCheckUntil && Date.now()>=ROOM.finishCheckUntil){
    const uid = ROOM.finishCheckUid;
    updateRoom(room=>{
      if(!room.modal || room.modal.type!=='finishCheck' || room.finishCheckUid!==uid) return { error:'stale' };
      return roomFinishCheckAnswer(room, uid, false);
    });
    return;
  }
  if(!ROOM || ROOM.phase!=='playing' || !ROOM.turnStartedAt) return;
  const elapsed = Date.now() - ROOM.turnStartedAt;
  const timerUid = ROOM.timerUid;
  if(timerUid && !ROOM.players[timerUid].isAI){
    if(timerUid===myUid && elapsed>=TURN_LIMIT_MS){
      forceSkipTurn(myUid);
      return;
    }
    if(timerUid!==myUid && elapsed>=WATCHDOG_GRACE_MS){
      forceSkipTurn(timerUid);
      return;
    }
  }
  render();
}
setInterval(tickTimer, 1000);

/* ============================= ADAPTIVE CARD SIZE =============================
   Calculates --card-w so all cards (opponent + player) are the same size and
   everything fits on one screen without scrolling wherever possible. Called
   after every render. */
function updateCardSize(){
  if(!ROOM || ROOM.phase!=='playing') return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const availW = Math.min(vw, 1080) - 24;
  const compact = (ROOM.turnOrder.length - 1) >= 4;

  const others = ROOM.turnOrder.filter(u=>u!==myUid);
  const numOpponents = others.length;
  const myCards = Math.max((ROOM.players[myUid]?.hand||[]).length, 4);
  const maxOppCards = others.reduce((m,u)=>Math.max(m,(ROOM.players[u]?.hand||[]).length),0) || 4;

  // Column count scales with actual available width — wide screens (like a
  // desktop browser) get enough columns to fit ALL opponents in one row
  // when there's room, which minimizes total height far more than always
  // wrapping into extra rows. Narrower screens fall back to fewer columns.
  const widthBasedCols = Math.max(2, Math.floor(availW / 190));
  const oppCols = Math.max(2, Math.min(numOpponents, widthBasedCols, 6));
  document.documentElement.style.setProperty('--opp-cols', oppCols);
  document.body.classList.toggle('many-players', numOpponents >= 4);

  // Chrome heights (smaller in compact/many-player mode; tightened to match
  // the phone-compact CSS which now renders noticeably smaller than before)
  const headerH = compact ? 30 : 64;
  const actionsH = 42;
  const midrowH = compact ? 36 : 64;
  const playerNameH = compact ? 20 : 34;
  const gaps = 10;
  const fixedH = headerH + actionsH + midrowH + playerNameH + gaps;
  const remaining = Math.max(100, vh - fixedH);

  const oppRows = Math.ceil(numOpponents / oppCols);
  const oppAreaH = remaining * 0.44;
  const oppBlockH = (oppAreaH / oppRows) - 6;
  const oppBlockNameH = compact ? 16 : 26;
  const availOppCardH = oppBlockH - oppBlockNameH;
  const colW = (availW / oppCols) - (oppCols-1)*4;
  const cardsPerOppRow = Math.max(2, Math.ceil(maxOppCards / 2));
  const cardWFromOppW = Math.floor((colW - (cardsPerOppRow-1)*4) / cardsPerOppRow);
  const oppCardRows = Math.ceil(maxOppCards / cardsPerOppRow);
  const cardHFromOppH = Math.floor((availOppCardH - (oppCardRows-1)*4) / oppCardRows);
  const cardWFromOppH = Math.floor(cardHFromOppH * (2/3));

  // Player hand
  const playerAreaH = remaining * 0.50;
  const cardWFromMyW = Math.floor((availW - (myCards-1)*6) / myCards);
  const cardWFromMyH = Math.floor((playerAreaH - playerNameH - 18) * (2/3));

  // The floor used to stay ~105px no matter how many players were on
  // screen, which is what forced scrolling with 4-5 opponents. It now
  // scales down as more opponents need to fit.
  const minSize = numOpponents >= 5 ? 28 : numOpponents >= 4 ? 34 : Math.max(40, Math.floor(availW / 10));
  const final = Math.max(minSize, Math.min(cardWFromOppW, cardWFromOppH, cardWFromMyW, cardWFromMyH, 96));
  document.documentElement.style.setProperty('--card-w', final+'px');
}



function actLeaveToMenu(){
  if(roomRef) roomRef.off();
  roomRef=null; ROOM=null; ROOM_CODE=null; VIEW='landing'; PENDING_MODE=null;
  LOCAL_MODE=false; processingLocalAI=false; gameResultRecorded=false;
  render();
}
function actQuitToMenu(){
  if(window.confirm(t('quitConfirm'))){
    actLeaveToMenu();
  }
}
function copyInviteLink(){
  const url = window.location.origin + window.location.pathname + '?room=' + ROOM_CODE;
  const el = document.getElementById('inviteLinkField');
  if(el){ el.select(); document.execCommand && document.execCommand('copy'); }
  if(navigator.clipboard){ navigator.clipboard.writeText(url).catch(()=>{}); }
  const btn = document.getElementById('copyLinkBtnEl');
  if(btn){ btn.textContent = t('linkCopied'); setTimeout(()=>render(), 1200); }
}

/* ============================= RENDER: SCREENS ============================= */
function screenHeader(subtitleOverride, showQuit, compact){
  return `<div class="header ${compact?'header-compact':''}">
    <div>
      <div class="title">${t('title')}</div>
      ${compact?'':`<div class="tagline">${subtitleOverride || t('subtitle')}</div>`}
      ${compact?`<div class="tagline" style="font-size:9px;letter-spacing:1px">${subtitleOverride||''}</div>`:''}
    </div>
    <div class="choice-group" style="align-self:flex-start">
      ${showQuit? `<button class="quit-btn" data-action="actQuitToMenu" title="${t('quitBtn')}">✕</button>`:''}
      <button class="quit-btn" data-action="toggleSound" title="${t('soundBtn')}">${soundOn?'🔊':'🔇'}</button>
      <button class="choice-btn ${LANG==='en'?'active':''}" data-action="setLang" data-val="en">EN</button>
      <button class="choice-btn ${LANG==='ar'?'active':''}" data-action="setLang" data-val="ar">ع</button>
    </div>
  </div>`;
}

function renderLandingHeader(){
  return `<div class="header header-landing">
    <div class="choice-group">
      <button class="quit-btn" data-action="toggleSound" title="${t('soundBtn')}">${soundOn?'🔊':'🔇'}</button>
      <button class="choice-btn ${LANG==='en'?'active':''}" data-action="setLang" data-val="en">EN</button>
      <button class="choice-btn ${LANG==='ar'?'active':''}" data-action="setLang" data-val="ar">ع</button>
    </div>
  </div>`;
}

function renderLandingEmblem(){
  return `<img class="landing-emblem" src="assets/images/logo-full.webp" alt="Zhaimer" width="180" height="98" />`;
}

function renderLanding(){
  let fbNote = '';
  if(!fbReady){
    fbNote = `<div class="setup-explainer" style="border-top:none;margin-top:14px;color:var(--crimson)">${t('firebaseMissing')}</div>`;
  }
  return `${renderLandingHeader()}
  <div class="landing-hero">
    <img class="landing-hero-banner" src="assets/images/landing-hero.webp" alt="Zhaimer - The Game of Hidden Strategy" />
  </div>
  ${renderPublicPlayerCount()}
  <div class="setup-card landing-card">
    <div class="dest-title">${t('modeQuestion')}</div>
    <button class="dest-row dest-gold" data-action="goAISetup">
      <span class="dest-icon">🧠</span>
      <span class="dest-text">
        <span class="dest-label">${t('playAIBtn')}</span>
      </span>
      <span class="dest-arrow">›</span>
    </button>
    <button class="dest-row dest-blue" data-action="goCreate" ${!fbReady?'disabled':''}>
      <span class="dest-icon">👥</span>
      <span class="dest-text">
        <span class="dest-label">${t('createRoomBtn')}</span>
      </span>
      <span class="dest-arrow">›</span>
    </button>
    <button class="dest-row dest-teal" data-action="goJoin" ${!fbReady?'disabled':''}>
      <span class="dest-icon">🔑</span>
      <span class="dest-text">
        <span class="dest-label">${t('joinRoomBtn')}</span>
      </span>
      <span class="dest-arrow">›</span>
    </button>
    <button class="dest-row dest-purple" data-action="goRules">
      <span class="dest-icon">📖</span>
      <span class="dest-text">
        <span class="dest-label">${t('howToPlayBtn')}</span>
      </span>
      <span class="dest-arrow">›</span>
    </button>
    <button class="dest-row dest-theme" data-action="goTheme">
      <span class="dest-icon">${THEME_DEFS[currentTheme]?.icon || '🎨'}</span>
      <span class="dest-text">
        <span class="dest-label">${t('themeBtn')}</span>
        <span class="dest-sub">${themePref==='random' ? t('themeRandomLabel') : (LANG==='ar'?THEME_DEFS[currentTheme].labelAr:THEME_DEFS[currentTheme].labelEn)}</span>
      </span>
      <span class="dest-arrow">›</span>
    </button>
    ${fbNote}
  </div>
  <div class="trailer-slot" id="trailerSlot">
    ${hasSeenTrailer() ? `
    <video id="zhaimerTrailer" class="trailer-video" src="assets/videos/zhaimer-trailer.mp4"
      muted playsinline preload="metadata"></video>
    <button class="trailer-play-overlay" id="trailerPlayOverlay" data-action="playTrailer">
      <span class="trailer-play-icon">▶</span>
      <span class="trailer-play-label">${t('watchIntroBtn')}</span>
    </button>
    ` : `
    <video id="zhaimerTrailer" class="trailer-video" src="assets/videos/zhaimer-trailer.mp4"
      autoplay muted playsinline preload="metadata"></video>
    <button class="trailer-unmute" id="trailerUnmute" data-action="toggleTrailerSound" title="${t('unmuteBtn')}">🔇</button>
    `}
    <div class="trailer-donate-overlay" id="trailerDonateOverlay" style="display:none;">
      <p>${t('trailerDonateText')}</p>
      <div class="trailer-donate-actions">
        ${DONATE_URL && !DONATE_URL.startsWith('PASTE_') ? `<a href="${DONATE_URL}" target="_blank" rel="noopener" class="support-link">☕ ${t('supportBtn')}</a>` : ''}
        <button class="ghost-btn" data-action="replayTrailer">${t('replayBtn')}</button>
      </div>
    </div>
  </div>
  <div class="legal-footer">
    <button class="link-btn" data-action="goPrivacy">${t('privacyBtn')}</button>
    <span>·</span>
    <button class="link-btn" data-action="goTerms">${t('termsBtn')}</button>
  </div>
  <div class="signature-mark">◆ KMB ◆</div>`;
}

function renderPrivacy(){
  return `${screenHeader()}
  <div class="setup-card rules-card">
    <h2>${t('privacyTitle')}</h2>
    <div class="rules-body">${t('privacyBody')}</div>
    <div class="actions" style="margin-top:18px">
      <button class="primary-btn" data-action="goBackToLanding">${t('backBtn')}</button>
    </div>
  </div>`;
}

function renderTerms(){
  return `${screenHeader()}
  <div class="setup-card rules-card">
    <h2>${t('termsTitle')}</h2>
    <div class="rules-body">${t('termsBody')}</div>
    <div class="actions" style="margin-top:18px">
      <button class="primary-btn" data-action="goBackToLanding">${t('backBtn')}</button>
    </div>
  </div>`;
}

function renderThemePicker(){
  const rows = ['random', ...THEME_KEYS].map(key=>{
    const selected = themePref === key;
    const label = key==='random' ? t('themeRandomLabel')
      : (LANG==='ar' ? THEME_DEFS[key].labelAr : THEME_DEFS[key].labelEn);
    const icon = key==='random' ? '🎲' : THEME_DEFS[key].icon;
    return `<button class="dest-row theme-pick-row ${selected?'theme-pick-selected':''}" data-action="pickTheme" data-val="${key}">
      <span class="dest-icon">${icon}</span>
      <span class="dest-text"><span class="dest-label">${label}</span></span>
      <span class="dest-arrow">${selected?'✓':''}</span>
    </button>`;
  }).join('');
  return `${screenHeader()}
  <div class="setup-card rules-card">
    <h2>${t('themeBtn')}</h2>
    <p class="small-note" style="margin:0 0 14px;">${t('themeExplain')}</p>
    ${rows}
    <div class="actions" style="margin-top:18px">
      <button class="primary-btn" data-action="goBackToLanding">${t('backBtn')}</button>
    </div>
  </div>`;
}
function renderRules(){
  return `${screenHeader()}
  <div class="setup-card rules-card">
    <h2>${t('rulesTitle')}</h2>
    <div class="rules-body">${t('rulesBody')}</div>
    <div class="actions" style="margin-top:18px">
      <button class="primary-btn" data-action="goBackToLanding">${t('backBtn')}</button>
    </div>
  </div>`;
}
function renderAISetup(){
  return `${screenHeader()}
  <div class="setup-card">
    <h2>${t('playAIBtn')}</h2>
    <div class="setup-row">
      <label style="display:block;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">${t('yourNameLabel')}</label>
      <input id="aiNameField" class="field-input" maxlength="20" placeholder="${t('namePlaceholder')}" value="${(myName||'').replace(/"/g,'')}" />
    </div>
    <div class="setup-row">
      <label style="display:block;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">${t('opponentsLabel')}</label>
      <div class="choice-group">
        ${[1,2,3,4,5].map(n=>`<button class="choice-btn ${NUM_AI===n?'active':''}" data-action="setNumAI" data-val="${n}">${n}</button>`).join('')}
      </div>
    </div>
    <div class="setup-row">
      <label style="display:block;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">${t('difficultyLabel')}</label>
      <div class="choice-group">
        ${['easy','medium','hard'].map(d=>`<button class="choice-btn ${DIFFICULTY===d?'active':''}" data-action="setDifficulty" data-val="${d}">${t('diff_'+d)}</button>`).join('')}
      </div>
    </div>
    <div class="actions" style="margin-top:16px">
      <button class="ghost-btn" data-action="goBackToLanding">${t('backBtn')}</button>
      <button class="primary-btn" data-action="submitAISetup">${t('dealBtn')}</button>
    </div>
  </div>`;
}

function renderNameEntry(){
  return `${screenHeader()}
  <div class="setup-card">
    <h2>${t('yourNameLabel')}</h2>
    <input id="nameField" class="field-input" maxlength="20" placeholder="${t('namePlaceholder')}" value="${myName.replace(/"/g,'')}" />
    <div class="actions" style="margin-top:16px">
      <button class="ghost-btn" data-action="goBackToLanding">${t('backBtn')}</button>
      <button class="primary-btn" data-action="submitNameEntry">${t('continueBtn')}</button>
    </div>
  </div>`;
}

function renderJoinCodeEntry(){
  return `${screenHeader()}
  <div class="setup-card">
    <h2>${t('roomCodeLabel')}</h2>
    <input id="joinCodeField" class="field-input" maxlength="6" style="text-transform:uppercase;letter-spacing:4px;text-align:center;font-size:20px" placeholder="${t('codePlaceholder')}" value="${JOIN_CODE_INPUT}" />
    ${joinError? `<div class="small-note" style="color:var(--crimson);margin-top:8px">${joinError}</div>` : ''}
    <div class="actions" style="margin-top:16px">
      <button class="ghost-btn" data-action="goBackToLanding">${t('backBtn')}</button>
      <button class="primary-btn" data-action="submitJoinCode">${t('joinBtn')}</button>
    </div>
  </div>`;
}

function renderLobby(){
  const isHost = ROOM.hostUid===myUid;
  const players = ROOM.turnOrder.map(uid=>ROOM.players[uid]);
  return `${screenHeader(null, true)}
  <div class="setup-card">
    <div class="room-code-display">${ROOM_CODE}</div>
    <div class="small-note" style="text-align:center">${t('shareHint')}</div>
    <div class="link-row">
      <input id="inviteLinkField" class="field-input" readonly value="${window.location.origin+window.location.pathname}?room=${ROOM_CODE}" />
      <button id="copyLinkBtnEl" class="ghost-btn" data-action="copyInviteLink">${t('copyLinkBtn')}</button>
    </div>
    <div class="lobby-list">
      <div class="small-note" style="text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">${t('playersInRoom')} (${players.length}/6)</div>
      ${ROOM.turnOrder.map(uid=>`
        <div class="lobby-player">
          <span>${ROOM.players[uid].name}${uid===myUid? ` (${t('you')})`:''}</span>
          ${uid===ROOM.hostUid? `<span class="host-tag">${t('hostTag')}</span>`:''}
        </div>`).join('')}
    </div>
    ${isHost
      ? `<button class="primary-btn" style="width:100%" data-action="actStartGame" ${players.length<2?'disabled':''}>${t('startGameBtn')}</button>
         ${players.length<2? `<div class="small-note" style="text-align:center;margin-top:8px">${t('needMorePlayers')}</div>`:''}`
      : `<div class="small-note" style="text-align:center">${t('waitingForHost')}</div>`}
  </div>`;
}

const PLAYER_PALETTE = [
  {pc:'#c9a227', pcSoft:'#e9c65c', rgb:'201,162,39'},   // brass
  {pc:'#3fc7b6', pcSoft:'#7fe0d3', rgb:'63,199,182'},   // teal
  {pc:'#c1495a', pcSoft:'#e08a97', rgb:'193,73,90'},    // crimson
  {pc:'#8a7fd1', pcSoft:'#b6aeea', rgb:'138,127,209'},  // violet
  {pc:'#e2954a', pcSoft:'#f0b878', rgb:'226,149,74'},   // amber
  {pc:'#6fae7f', pcSoft:'#a3d4b0', rgb:'111,174,127'},  // sage
];
function timerSecondsLeft(){
  if(!ROOM || !ROOM.turnStartedAt) return null;
  const remain = Math.ceil((TURN_LIMIT_MS - (Date.now() - ROOM.turnStartedAt)) / 1000);
  return Math.max(0, remain);
}
function timerBadgeHtml(uid){
  if(!ROOM || ROOM.timerUid!==uid || ROOM.phase!=='playing') return '';
  const secs = timerSecondsLeft();
  if(secs===null) return '';
  const low = secs<=10;
  return `<div class="timer-badge ${low?'low':''}">⏱ ${secs}s</div>`;
}
function playerColor(uid){
  if(!ROOM) return PLAYER_PALETTE[0];
  const idx = ROOM.turnOrder.indexOf(uid);
  return PLAYER_PALETTE[(idx<0?0:idx) % PLAYER_PALETTE.length];
}
function avatarInitial(name){
  return (name||'?').trim().charAt(0).toUpperCase() || '?';
}
function colorStyleVars(col){
  return `--pc:${col.pc}; --pc-soft:${col.pcSoft}; --pc-rgb:${col.rgb};`;
}

function renderPlayerBlock(uid){
  const p = ROOM.players[uid];
  const col = playerColor(uid);
  const activeNow = ROOM.phase==='playing' && ROOM.currentUid===uid;
  const declared = ROOM.finishedBy===uid;
  const targetable = ROOM.modal && ROOM.modal.type==='jackTarget' && ROOM.currentUid===myUid;
  const jp = ROOM.modal && ROOM.modal.type==='jackPreview' ? ROOM.modal : null;
  // This check only ever evaluates true on the swapper's own device: it
  // requires ROOM.currentUid===myUid, and only the swapper is currentUid
  // for the whole duration of the preview. The victim's client, other
  // players' clients, and any spectator all fail this check and keep
  // rendering the plain face-down back below.
  const isPreviewedBySelf = jp && jp.targetUid===uid && ROOM.currentUid===myUid;
  const rc = ROOM.recentChange;
  let cardsHtml = '';
  for(let i=0;i<p.hand.length;i++){
    const cls = targetable? 'clickable opp-slot-target':'';
    const justChanged = rc && rc.uid===uid && rc.slot===i;
    if(isPreviewedBySelf && jp.targetSlot===i){
      cardsHtml += `<div style="position:relative">${renderCardFace(jp.card, 'jack-preview-face')}</div>`;
    } else {
      cardsHtml += `<div style="position:relative">${renderCardBack(cls + (justChanged?' just-changed':''))}${targetable?`<div style="position:absolute;inset:0" data-action="actJackTarget" data-player="${uid}" data-slot="${i}"></div>`:''}</div>`;
    }
  }
  return `<div class="player-block ${activeNow?'active-turn':''} ${declared?'declared':''}" style="${colorStyleVars(col)} ${p.eliminated?'opacity:.4':''}">
    ${timerBadgeHtml(uid)}
    <div class="player-row-top">
      <div class="avatar">${avatarInitial(p.name)}</div>
      <div class="player-namecol">
        <div class="player-name">
          <span class="nm">${p.name}${uid===myUid?` (${t('you')})`:''}${p.isAI?' 🤖':''}</span>
          ${declared ? `<span class="declare-badge">🏁 ${t('declaredTag')}</span>` : ''}
        </div>
        <span class="badge total">${p.total} ${t('pts')}</span>
      </div>
    </div>
    ${p.eliminated?`<div class="turn-tag" style="color:var(--crimson)">${t('eliminatedTag')}</div>`:activeNow?`<div class="turn-tag">${t('theirTurn')}</div>`:''}
    ${!p.eliminated && declared?`<div class="turn-tag" style="color:var(--teal)">${t('declaredTag')}</div>`:''}
    ${p.eliminated?'':`<div class="hand">${cardsHtml}</div>`}
  </div>`;
}

function renderMyHand(){
  const me = ROOM.players[myUid];
  let html = '';
  const isMyTurn = ROOM.currentUid===myUid;
  const myBurnTurn = isMyTurn && ROOM.phase==='playing' && !ROOM.drawnCard && !ROOM.modal;
  for(let i=0;i<me.hand.length;i++){
    const peeking = ROOM.phase==='peek' && peekSelected.includes(i) && peekRevealUntil && Date.now()<peekRevealUntil;
    const peekSelectable = ROOM.phase==='peek' && peekSelected.length<2 && !peekSelected.includes(i) && !ROOM.peekedUids.includes(myUid);
    const swappable = ROOM.phase==='playing' && isMyTurn && ROOM.drawnCard;
    const m = ROOM.modal;
    const kingSlot = isMyTurn && m && m.type==='kingSlot';
    const kingSlotBoth1 = isMyTurn && m && m.type==='kingSlotBoth1';
    const kingSlotBoth2 = isMyTurn && m && m.type==='kingSlotBoth2' && m.usedSlot!==i;
    const jackOwn = isMyTurn && m && m.type==='jackOwn';
    const jackTargetOwn = isMyTurn && m && m.type==='jackTarget';
    const queenPick = isMyTurn && m && m.type==='queenPick';
    const burnAttempt = myBurnTurn && burnDeclared;
    const isSelectedForBurn = burnAttempt && burnSelected.includes(i);

    let inner, action='';
    if(peeking){ inner = renderCardFace(me.hand[i]); }
    else if(peekSelectable){ inner = renderCardBack('clickable selectable'); action = `data-action="humanPeek" data-slot="${i}"`; }
    else if(ROOM.phase==='peek'){ inner = renderCardBack(peekSelected.includes(i)?'selectable':''); }
    else if(swappable){ inner = renderCardBack('clickable own-slot-target'); action = `data-action="actChooseSlot" data-slot="${i}" data-drop="slot"`; }
    else if(kingSlot){ inner = renderCardBack('clickable own-slot-target'); action = `data-action="actKingSlot" data-slot="${i}"`; }
    else if(kingSlotBoth1){ inner = renderCardBack('clickable own-slot-target'); action = `data-action="actKingSlotBoth1" data-slot="${i}"`; }
    else if(kingSlotBoth2){ inner = renderCardBack('clickable own-slot-target'); action = `data-action="actKingSlotBoth2" data-slot="${i}"`; }
    else if(jackOwn){ inner = renderCardBack('clickable own-slot-target'); action = `data-action="actJackOwn" data-slot="${i}"`; }
    else if(jackTargetOwn){ inner = renderCardBack(); }
    else if(queenPick){ inner = renderCardBack('clickable own-slot-target'); action = `data-action="actQueenPeek" data-slot="${i}"`; }
    else if(burnAttempt){
      const cls = isSelectedForBurn ? 'clickable selectable' : 'clickable own-slot-target';
      inner = renderCardBack(cls);
      action = `data-action="toggleBurnSlot" data-slot="${i}"`;
    }
    else{
      const rc = ROOM.recentChange;
      const justChangedMine = rc && rc.uid===myUid && rc.slot===i;
      inner = renderCardBack(justChangedMine ? 'just-changed' : '');
    }
    html += `<div ${action} style="display:flex;flex-direction:column;align-items:center;">${inner}<span class="slot-label">${i+1}</span></div>`;
  }
  return html;
}

function renderMidRow(compact){
  const topDiscard = ROOM.discard[ROOM.discard.length-1];
  const discardVisual = topDiscard ? renderCardFace(topDiscard) : `<div class="empty-slot" aria-label="empty"></div>`;
  if(compact){
    return `<div class="midrow" style="gap:12px;padding:3px 0">
      <div class="pile">
        ${renderCardBack()}
        <div class="pile-count">${ROOM.deck.length} ${t('leftLabel')}</div>
      </div>
      <div class="pile">
        ${discardVisual}
        <div class="pile-count">${ROOM.discard.length}</div>
      </div>
    </div>`;
  }
  return `<div class="midrow">
    <div class="pile">
      <div class="pile-label">${t('deckLabel')}</div>
      ${renderCardBack()}
      <div class="pile-count">${ROOM.deck.length} ${t('leftLabel')}</div>
    </div>
    <div class="pile">
      <div class="pile-label">${t('discardLabel')}</div>
      ${discardVisual}
      <div class="pile-count">${ROOM.discard.length} ${t('inPileLabel')}</div>
    </div>
  </div>`;
}

function renderActions(){
  if(ROOM.phase==='peek'){
    if(ROOM.peekedUids.includes(myUid)){
      return `<div class="actions"><div class="hint" style="color:var(--muted);font-size:12.5px;">${t('waitingForPeeks')}</div></div>`;
    }
    return `<div class="actions"><div class="hint" style="color:var(--muted);font-size:12.5px;">${t('peekHint')}</div></div>`;
  }
  if(ROOM.phase!=='playing') return '';
  const isMyTurn = ROOM.currentUid===myUid;
  if(!isMyTurn){
    return `<div class="actions"><div style="color:var(--muted); font-size:13px;">${t('waitingFor', ROOM.players[ROOM.currentUid].name)}</div></div>`;
  }
  if(ROOM.modal && ROOM.modal.type==='finishCheck'){
    return `<div class="actions">
      <button class="primary-btn" data-action="actDraw" data-val="deck">${t('drawDeckBtn')}</button>
      <button class="ghost-btn" data-action="actDraw" data-val="discard" ${ROOM.discard.length===0?'disabled':''}>${t('drawDiscardBtn')}</button>
      ${ROOM.discard.length>0?`<button class="ghost-btn burn-btn" data-action="declareBurnAttempt">🔥 ${t('burnBtn')}</button>`:''}
      <button class="ghost-btn" style="border-color:var(--teal);color:var(--teal);font-weight:700;" data-action="actFinishCheckAnswer" data-val="yes">🏁 ${t('declareFinishedBtn')}</button>
    </div>`;
  }
  if(ROOM.modal) return '';
  if(!ROOM.drawnCard){
    if(burnDeclared){
      return `<div class="actions">
        <div class="hint" style="color:var(--muted);font-size:12.5px;">${t('pickBurnCard')}</div>
        ${burnSelected.length>0
          ? `<button class="primary-btn burn-btn" data-action="confirmBurn">🔥 ${t('burnConfirmBtn', burnSelected.length)}</button>`
          : ''}
        <button class="ghost-btn" data-action="cancelBurnAttempt">${t('backBtn')}</button>
      </div>`;
    }
    return `<div class="actions">
      <button class="primary-btn" data-action="actDraw" data-val="deck">${t('drawDeckBtn')}</button>
      <button class="ghost-btn" data-action="actDraw" data-val="discard" ${ROOM.discard.length===0?'disabled':''}>${t('drawDiscardBtn')}</button>
      ${ROOM.discard.length>0?`<button class="ghost-btn burn-btn" data-action="declareBurnAttempt">🔥 ${t('burnBtn')}</button>`:''}
    </div>`;
  }
  const canDiscardDirect = ROOM.drawnCard.source==='deck';
  return `<div class="actions"><div class="drawn-panel">
      <div draggable="true" data-drag="drawnCard" class="draggable-card">${renderCardFace(ROOM.drawnCard.card,'big')}</div>
      <div class="hint">${canDiscardDirect? t('swapHintDiscard') : t('swapHintNo')}</div>
      ${canDiscardDirect? `<button class="ghost-btn" data-action="actDiscardDrawn">${t('discardDirectlyBtn')}</button>`:''}
    </div></div>`;
}

function renderModal(){
  const isMyTurn = ROOM.currentUid===myUid;
  if(!ROOM.modal) return '';
  if(!isMyTurn){
    // Special case: if this swapDone modal targeted ME specifically, I get
    // a clear notice that a swap happened and which of my slots changed —
    // but never what the card actually is. Everyone else (non-victims,
    // spectators) still just sees the generic waiting banner below.
    if(ROOM.modal.type==='swapDone' && ROOM.modal.victimUid===myUid){
      return bannerWrap(t('jackVictimTitle'), t('jackVictimBody', ROOM.modal.victimSlot+1));
    }
    return bannerWrap(t('waitingFor', ROOM.players[ROOM.currentUid].name), '');
  }
  const m = ROOM.modal;
  if(m.type==='finishCheck') return '';
  if(m.type==='askAbility'){
    return modalWrap(`<h3>${t('abilityTitle', m.card.rank)}</h3>
      <p>${t('abilityBody', m.card.rank, m.card.rank+m.card.suit)}</p>
      <div class="modal-actions">
        <button class="primary-btn" data-action="actAnswerAbility" data-val="yes">${t('usePowerBtn')}</button>
        <button class="ghost-btn" data-action="actAnswerAbility" data-val="no">${t('discardPlainBtn')}</button>
      </div>`);
  }
  if(m.type==='king'){
    return modalWrap(`<h3>${t('kingTitle')}</h3>
      <p>${t('kingBody')}</p>
      <div class="modal-cards">
        <div>${renderCardFace(m.c1,'big')}<div style="margin-top:6px"><button class="ghost-btn" data-action="actKingChoose" data-val="c1">${t('keepThisBtn')}</button></div></div>
        <div>${renderCardFace(m.c2,'big')}<div style="margin-top:6px"><button class="ghost-btn" data-action="actKingChoose" data-val="c2">${t('keepThisBtn')}</button></div></div>
      </div>
      <div class="modal-actions">
        <button class="primary-btn" data-action="actKingChoose" data-val="both">${t('keepBothBtn')}</button>
        <button class="ghost-btn" data-action="actKingChoose" data-val="none">${t('discardBothBtn')}</button>
      </div>`);
  }
  if(m.type==='kingSlot') return bannerWrap(t('kingSlotTitle'), t('kingSlotBody'));
  if(m.type==='kingSlotBoth1') return bannerWrap(t('kingSlotTitle'), t('kingSlotBoth1Body'));
  if(m.type==='kingSlotBoth2') return bannerWrap(t('kingSlotTitle'), t('kingSlotBoth2Body'));
  if(m.type==='jackOwn') return bannerWrap(t('jackOwnTitle'), t('jackOwnBody'));
  if(m.type==='jackTarget') return bannerWrap(t('jackTargetTitle'), t('jackTargetBody'));
  if(m.type==='jackPreview'){
    return modalWrap(`<h3>${t('jackPreviewTitle')}</h3>
      <p style="font-size:13px;color:var(--muted);margin-bottom:10px;">${t('jackPreviewBody')}</p>
      <div style="display:flex;justify-content:center;margin:10px 0;">${renderCardFace(m.card,'big')}</div>
      <div class="jack-preview-bar-track">
        <div class="jack-preview-bar-fill" data-reveal-until="${m.revealUntil}" data-duration="${JACK_PREVIEW_MS}"></div>
      </div>
      <div class="actions" style="margin-top:14px;">
        <button class="primary-btn" data-action="actJackConfirmSwap">${t('jackPreviewContinueBtn')}</button>
      </div>`);
  }
  if(m.type==='swapDone'){
    // Only the swapper (current turn player) reaches this specific block.
    // The victim gets their own separate notice (see the special case
    // earlier in this function, above the isMyTurn gate) — they're told
    // a swap happened and which slot changed, but never the card's
    // identity. Everyone else (non-victims, spectators) sees nothing.
    const title = t('swapDoneTitle');
    const body = t('swapDoneBody', m.withName);
    return modalWrap(`<h3>${title}</h3>
      <p style="font-size:14px;color:var(--brass-soft)">${body}</p>
      <div class="modal-actions"><button class="primary-btn" data-action="actSwapDoneAck">${t('continueTurn')}</button></div>`);
  }
  if(m.type==='queenPick') return bannerWrap(t('queenPickTitle'), t('queenPickBody'));
  if(m.type==='queenReveal'){
    return modalWrap(`<h3>${t('queenGlimpseTitle')}</h3><p style="font-size:16px;color:var(--brass-soft)">${t('slotVal', m.slotIdx+1, m.rank, m.suit, m.value)}</p>
      <div class="modal-actions"><button class="primary-btn" data-action="actQueenAck">${t('continueTurn')}</button></div>`);
  }
  return '';
}

function renderReveal(){
  const results = ROOM.roundResults.slice().sort((a,b)=>a.score-b.score);
  const minScore = Math.min(...results.map(r=>r.score));
  const compact = (ROOM.turnOrder.length - 1) >= 4;
  const nextBtn = ROOM.hostUid===myUid
    ? `<button class="primary-btn" style="width:100%" data-action="actNextRound">${ROOM.turnOrder.filter(u=>!ROOM.players[u].eliminated).length<=1? t('seeResultBtn'):t('nextRoundBtn')}</button>`
    : `<div class="small-note" style="text-align:center;">${t('waitingForHost')}</div>`;

  return `<div class="table">
  ${screenHeader(`${t('round')} ${ROOM.round}`, true, compact)}
  <div class="reveal-wrap">
    <div class="reveal-scroll">
      <h2 style="margin:0 0 8px;font-size:16px;">${t('revealHeading', ROOM.round)}</h2>
      ${results.map(r=>{
        const isRoundWinner = r.score===minScore;
        const scoreColor = r.roundScore>r.score ? 'var(--crimson)' : (isRoundWinner ? 'var(--teal)' : 'var(--brass-soft)');
        return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);">
          <div style="display:flex;gap:6px;align-items:center;min-width:0;flex:1;">
            <b style="white-space:nowrap;font-size:13px;">${r.name}${ROOM.finishedBy===r.uid?' 🎯':''}${isRoundWinner?' 🏆':''}</b>
            <div style="display:flex;gap:3px;flex-wrap:wrap;">${(r.hand||[]).map(c=>renderCardFace(c,'mini')).join('')}</div>
          </div>
          <div style="text-align:right;flex-shrink:0;margin-left:8px;">
            <div style="font-size:11px;color:var(--muted)">${t('rawLabel')} ${r.score}</div>
            <div style="font-weight:700;font-size:13px;color:${scoreColor}">+${r.roundScore}${r.roundScore>r.score?' '+t('penaltyTag'):''}${isRoundWinner&&r.score>0?' '+t('roundWinTag'):''}</div>
          </div>
        </div>`;}).join('')}
      ${ROOM.roundWinnerName? `<p style="color:var(--teal);margin:6px 0 0;font-size:12px;">${t('roundWinnerMsg', ROOM.roundWinnerName)}</p>`:''}
      ${ROOM.penaltyApplied? `<p style="color:var(--crimson);margin:4px 0 0;font-size:12px;">${t('penaltyMsg', ROOM.penaltyApplied)}</p>` : (ROOM.finishedBy!==null&&ROOM.players[ROOM.finishedBy]? `<p style="color:var(--brass-soft);margin:4px 0 0;font-size:12px;">${t('successMsg', ROOM.players[ROOM.finishedBy].name)}</p>`:'')}
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--line);">
        <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:4px;">${t('runningTotals')}</div>
        ${ROOM.turnOrder.map(uid=>`<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:13px;">
          <span>${ROOM.players[uid].name}${ROOM.players[uid].eliminated?` <span style="color:var(--crimson);font-size:11px;">(${t('eliminatedTag')})</span>`:''}</span>
          <b style="color:var(--brass-soft)">${ROOM.players[uid].total}</b>
        </div>`).join('')}
      </div>
    </div>
    <div class="reveal-footer">${nextBtn}</div>
  </div>
  </div>`;
}

function renderGameOver(){
  const winner = ROOM.turnOrder.map(u=>ROOM.players[u]).find(p=>!p.eliminated)
    || ROOM.turnOrder.map(u=>ROOM.players[u]).slice().sort((a,b)=>a.total-b.total)[0];
  const donateBtn = DONATE_URL && !DONATE_URL.startsWith('PASTE_')
    ? `<a href="${DONATE_URL}" target="_blank" rel="noopener" class="support-link" style="display:block;margin-top:10px;padding:13px;text-align:center;border-radius:10px;">☕ ${t('supportBtn')}</a>`
    : '';
  return `<div class="table">
  ${screenHeader()}
  <div class="reveal-wrap">
    <div class="reveal-scroll" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">
      <h2>${t('gameOverHeading')}</h2>
      <div style="font-family:Georgia,serif;font-size:24px;color:var(--brass-soft);margin:12px 0;">${t('winsLabel', winner.name)}</div>
      <div style="color:var(--muted);font-size:13px;">
        ${ROOM.turnOrder.map(uid=>`<div>${ROOM.players[uid].name}: ${ROOM.players[uid].total} ${t('pts')} ${ROOM.players[uid].eliminated?`(${t('eliminatedTag')})`:''}</div>`).join('')}
      </div>
    </div>
    <div class="reveal-footer" style="border-top:none;">
      <button class="primary-btn" style="width:100%" data-action="actLeaveToMenu">${t('playAgainBtn')}</button>
      ${donateBtn}
    </div>
  </div>
  </div>`;
}

/* ============================= MAIN RENDER ============================= */
function render(){
  applyTheme();
  const app = document.getElementById('app');
  let html = '';
  if(!(ROOM && ROOM.phase==='playing' && ROOM.currentUid===myUid && !ROOM.drawnCard && !ROOM.modal)){ burnDeclared = false; burnSelected = []; declareConfirmUntil = null; }
  if(VIEW==='landing' || !ROOM){
    document.body.classList.add('page-scroll');
    document.body.style.overflow = '';
    const appEl = document.getElementById('app');
    if(appEl){ appEl.style.height=''; appEl.style.minHeight=''; appEl.style.overflow=''; }
    const tableElPrev = document.querySelector('.table');
    if(tableElPrev) tableElPrev.style.transform = 'none';
    if(VIEW==='landing') html = renderLanding();
    else if(VIEW==='nameEntry') html = renderNameEntry();
    else if(VIEW==='joinCodeEntry') html = renderJoinCodeEntry();
    else if(VIEW==='aiSetup') html = renderAISetup();
    else if(VIEW==='rules') html = renderRules();
    else if(VIEW==='theme') html = renderThemePicker();
    else if(VIEW==='privacy') html = renderPrivacy();
    else if(VIEW==='terms') html = renderTerms();
    else html = renderLanding();
    app.innerHTML = html;
    attach();
    if(VIEW==='landing') setupTrailer();
    return;
  }
  document.body.classList.remove('page-scroll');
  // in a room
  if(ROOM.phase==='lobby'){ app.innerHTML = renderLobby(); attach(); return; }
  if(ROOM.phase==='roundEnd'){ app.innerHTML = renderReveal(); attach(); fitTableToScreen(); return; }
  if(ROOM.phase==='gameOver'){
    if(!gameResultRecorded){
      gameResultRecorded = true;
      const won = ROOM.players[myUid] && !ROOM.players[myUid].eliminated;
      const myScore = ROOM.players[myUid] ? ROOM.players[myUid].total : null;
      recordGameResult(won, myScore, ROOM.turnOrder.length-1, LOCAL_MODE?'ai':'online');
      if(won) sfxWin(); else sfxFail();
    }
    app.innerHTML = renderGameOver(); attach(); fitTableToScreen(); return;
  }

  const others = ROOM.turnOrder.filter(u=>u!==myUid);
  const compact = others.length >= 4;
  html = `<div class="table">`;
  html += screenHeader(`${t('round')} ${ROOM.round}${ROOM_CODE? ' · '+ROOM_CODE : ''}`, true, compact);
  html += `<div class="opponents">`;
  for(const uid of others) html += renderPlayerBlock(uid);
  html += `</div>`;
  html += renderMidRow(compact);
  const me = ROOM.players[myUid];
  const myCol = playerColor(myUid);
  const myActiveNow = ROOM.phase==='playing' && ROOM.currentUid===myUid;
  html += `<div class="human-block ${myActiveNow?'active-turn':''}" style="${colorStyleVars(myCol)}">
    ${timerBadgeHtml(myUid)}
    <div class="player-row-top">
      <div class="avatar">${avatarInitial(myName || t('you'))}</div>
      <div class="player-namecol">
        <div class="player-name"><span class="nm">${myName || t('you')}</span></div>
        <span class="badge total">${me.total} ${t('pts')}</span>
      </div>
    </div>
    ${me.eliminated
      ? `<div style="text-align:center;color:var(--muted);font-size:13px;padding:8px 0;">${t('spectating')}</div>`
      : `<div class="human-hand">${renderMyHand()}</div>${renderActions()}`}
  </div>`;
  html += `</div>`;
  html += renderModal();
  app.innerHTML = html;
  attach();
  updateCardSize();
  fitTableToScreen();
  manageJackPreviewTimer();
}

/* ============================= JACK PREVIEW TIMER =============================
   Runs only on the swapper's own client (the only one that ever renders
   the jackPreview modal, per the isMyTurn gate in renderModal). Keeps the
   on-screen countdown live and auto-confirms the swap once the 2 seconds
   are up, even if the player never clicks the button — so the card can
   never be left revealed indefinitely. */
let jackPreviewTimerId = null;
function clearJackPreviewTimers(){
  if(jackPreviewTimerId){ clearTimeout(jackPreviewTimerId); jackPreviewTimerId=null; }
}
function manageJackPreviewTimer(){
  const isJackPreview = ROOM && ROOM.modal && ROOM.modal.type==='jackPreview' && ROOM.currentUid===myUid;
  if(!isJackPreview){ clearJackPreviewTimers(); return; }
  const barEl = document.querySelector('.jack-preview-bar-fill');
  if(barEl && !barEl.dataset.started){
    barEl.dataset.started = '1';
    const duration = parseInt(barEl.dataset.duration,10) || JACK_PREVIEW_MS;
    const msLeft = Math.max(0, ROOM.modal.revealUntil - Date.now());
    // Start full, then let CSS animate it down to empty over exactly the
    // remaining time — purely visual, no numbers, no JS ticking needed.
    barEl.style.transition = 'none';
    barEl.style.width = '100%';
    requestAnimationFrame(()=>{
      barEl.style.transition = `width ${msLeft}ms linear`;
      barEl.style.width = '0%';
    });
  }
  if(jackPreviewTimerId) return; // auto-confirm timer already running
  const msLeft = Math.max(0, ROOM.modal.revealUntil - Date.now());
  jackPreviewTimerId = setTimeout(()=>{
    clearJackPreviewTimers();
    if(ROOM && ROOM.modal && ROOM.modal.type==='jackPreview' && ROOM.currentUid===myUid){
      actJackConfirmSwap();
    }
  }, msLeft);
}

/* ============================= FIT-TO-SCREEN SAFETY NET =============================
   updateCardSize() estimates sizes ahead of render, which can be slightly
   off across the huge range of real Android devices/browser chrome. This
   runs AFTER the table is actually in the DOM, measures its real height,
   and — if it's still taller than the screen — scales the whole table
   down uniformly so it genuinely fits with no scrolling. If fitting would
   require shrinking things past a legible size, it backs off and allows
   scrolling instead (see MIN_TABLE_SCALE) rather than producing an
   unreadable table — this is the deliberate "clear and proper" tradeoff. */
const MIN_TABLE_SCALE = 0.62;
function fitTableToScreen(){
  const tableEl = document.querySelector('.table');
  if(!tableEl) return;

  // The reveal/round-results screen already has its own working design:
  // a scrollable results list with the "Next Round" button pinned below
  // it, always reachable. That only works if .table has a genuinely
  // bounded height — so for this screen specifically, skip the
  // scale-transform approach entirely and just bound the height directly.
  const isRevealScreen = !!tableEl.querySelector('.reveal-wrap');
  if(isRevealScreen){
    tableEl.style.transform = 'none';
    tableEl.style.height = '100dvh';
    tableEl.style.maxHeight = '100dvh';
    tableEl.style.overflow = 'hidden';
    const wrap = tableEl.parentElement;
    if(wrap){ wrap.style.height=''; wrap.style.minHeight=''; wrap.style.overflow=''; }
    document.body.style.overflow = 'hidden';
    return;
  }

  tableEl.style.height = '';
  tableEl.style.maxHeight = '';
  tableEl.style.overflow = '';
  tableEl.style.transform = 'none';
  tableEl.style.transformOrigin = 'top center';
  const wrap = tableEl.parentElement;
  // Measure natural (unscaled) height
  const naturalH = tableEl.scrollHeight;
  const availH = window.innerHeight;
  if(naturalH <= availH + 2){
    // Already fits — no scaling needed, and scrolling stays disabled
    document.body.style.overflow = 'hidden';
    if(wrap){ wrap.style.height = ''; wrap.style.minHeight = ''; }
    return;
  }
  let scale = availH / naturalH;
  let usingFallbackScroll = false;
  if(scale < MIN_TABLE_SCALE){
    // Would become too small to read clearly — better to allow a short
    // scroll than to render illegible text/cards.
    scale = MIN_TABLE_SCALE;
    usingFallbackScroll = true;
    document.body.style.overflow = 'auto';
  } else {
    document.body.style.overflow = 'hidden';
  }
  tableEl.style.transform = `scale(${scale})`;
  // Compensate the layout box so scaling doesn't leave a gap or clip —
  // the element visually shrinks but its box still reserves natural
  // space, so we resize the wrapper to match what's actually visible.
  if(wrap){
    const scaledH = naturalH * scale;
    wrap.style.height = scaledH + 'px';
    wrap.style.minHeight = scaledH + 'px';
    // Only clip with overflow:hidden when everything truly fits — in the
    // fallback-scroll case, hidden overflow here would defeat the scroll.
    wrap.style.overflow = usingFallbackScroll ? 'visible' : 'hidden';
  }
}
window.addEventListener('resize', ()=>{ if(ROOM && ROOM.phase==='playing'){ updateCardSize(); fitTableToScreen(); } });

/* ============================= EVENT WIRING ============================= */
function attach(){
  const app = document.getElementById('app');
  app.onclick = (e)=>{
    const t2 = e.target.closest('[data-action]');
    if(!t2) return;
    const action = t2.dataset.action;
    const val = t2.dataset.val;
    const slot = t2.dataset.slot!==undefined? parseInt(t2.dataset.slot):null;
    const player = t2.dataset.player!==undefined? t2.dataset.player:null;
    if(action!=='toggleSound') sfxClick();
    switch(action){
      case 'setLang': setLang(val); break;
      case 'toggleSound': toggleSound(); break;
      case 'goCreate': goCreate(); break;
      case 'goJoin': goJoin(); break;
      case 'goAISetup': goAISetup(); break;
      case 'goRules': goRules(); break;
      case 'goTheme': goTheme(); break;
      case 'pickTheme': pickTheme(val); break;
      case 'goPrivacy': goPrivacy(); break;
      case 'toggleTrailerSound': toggleTrailerSound(); break;
      case 'playTrailer': playTrailer(); break;
      case 'replayTrailer': replayTrailer(); break;
      case 'goTerms': goTerms(); break;
      case 'setNumAI': setNumAIVal(parseInt(val)); break;
      case 'setDifficulty': setDifficultyVal(val); break;
      case 'submitAISetup': submitAISetup(); break;
      case 'goBackToLanding': goBackToLanding(); break;
      case 'submitNameEntry': submitNameEntry(); break;
      case 'submitJoinCode': submitJoinCode(); break;
      case 'copyInviteLink': copyInviteLink(); break;
      case 'actStartGame': actStartGame(); break;
      case 'humanPeek': humanTogglePeek(slot); break;
      case 'actDraw': actDraw(val); break;
      case 'actChooseSlot': actChooseSlot(slot); break;
      case 'actDiscardDrawn': actDiscardDrawn(); break;
      case 'actAnswerAbility': actAnswerAbility(val==='yes'); break;
      case 'actKingChoose': actKingChoose(val); break;
      case 'actKingSlot': actKingSlot(slot); break;
      case 'actKingSlotBoth1': actKingSlotBoth1(slot); break;
      case 'actKingSlotBoth2': actKingSlotBoth2(slot); break;
      case 'actJackOwn': actJackOwn(slot); break;
      case 'actJackTarget': actJackTarget(player, slot); break;
      case 'actJackConfirmSwap': actJackConfirmSwap(); break;
      case 'actSwapDoneAck': actSwapDoneAck(); break;
      case 'actQueenPeek': actQueenPeek(slot); break;
      case 'actQueenAck': actQueenAck(); break;
      case 'actAttemptBurn': actAttemptBurn(slot); break;
      case 'toggleBurnSlot': toggleBurnSlot(slot); break;
      case 'confirmBurn': confirmBurn(); break;
      case 'declareBurnAttempt': declareBurnAttempt(); break;
      case 'cancelBurnAttempt': cancelBurnAttempt(); break;
      case 'actFinishCheckAnswer': actFinishCheckAnswer(val==='yes'); break;
      case 'actNextRound': actNextRound(); break;
      case 'actLeaveToMenu': actLeaveToMenu(); break;
      case 'actQuitToMenu': actQuitToMenu(); break;
    }
  };

  // Drag-and-drop: drag the drawn card onto a hand slot to swap it in
  app.querySelectorAll('[data-drag="drawnCard"]').forEach(el=>{
    el.addEventListener('dragstart', (e)=>{
      e.dataTransfer.setData('text/plain', 'drawnCard');
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', ()=>{ el.classList.remove('dragging'); });
  });
  app.querySelectorAll('[data-drop="slot"]').forEach(el=>{
    el.addEventListener('dragover', (e)=>{ e.preventDefault(); el.classList.add('drag-hover'); });
    el.addEventListener('dragleave', ()=>{ el.classList.remove('drag-hover'); });
    el.addEventListener('drop', (e)=>{
      e.preventDefault();
      el.classList.remove('drag-hover');
      const kind = e.dataTransfer.getData('text/plain');
      if(kind==='drawnCard'){
        const slot = parseInt(el.dataset.slot);
        actChooseSlot(slot);
      }
    });
  });
}

/* ============================= BOOT ============================= */
document.documentElement.setAttribute('dir', LANG==='ar' ? 'rtl' : 'ltr');
document.documentElement.setAttribute('lang', LANG==='ar' ? 'ar' : 'en');
window.addEventListener('resize', ()=>{ updateCardSize(); });
const urlCode = checkUrlForRoomCode();
if(urlCode){ VIEW = myName ? 'joinCodeEntry' : 'nameEntry'; PENDING_MODE = 'join'; }
render();
