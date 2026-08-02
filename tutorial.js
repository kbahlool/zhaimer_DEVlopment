/* =============================================================================
   ZHAIMER — Interactive Tutorial ("Learn to Play")
   -----------------------------------------------------------------------------
   Self-contained guided practice mode. State (TUT) is entirely separate from
   the real game's ROOM object — nothing here ever reads or writes ROOM,
   localStorage stats, or the leaderboard. It only reuses two small pure
   helpers from game.js (cardValue, isRedSuit) and the shared .card CSS so the
   practice cards look identical to real ones. If game.js isn't loaded for
   some reason, local fallbacks are used so this file never throws.
   ============================================================================= */
(function(){
  'use strict';

  const cardValueFn = typeof window.cardValue === 'function' ? window.cardValue : function(c){
    if(c.rank==='A') return 1;
    if(c.rank==='10') return (c.suit==='♥'||c.suit==='♦') ? 0 : 10;
    if(['J','Q','K'].includes(c.rank)) return 10;
    return parseInt(c.rank,10);
  };
  const isRed = typeof window.isRedSuit === 'function' ? window.isRedSuit : function(s){ return s==='♥'||s==='♦'; };

  const STORAGE_DONE = 'zhaimer_tutorial_done';
  const STORAGE_INVITE_SEEN = 'zhaimer_tutorial_invite_seen';

  function storageGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function storageSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }

  function curLang(){
    return (document.documentElement.getAttribute('lang')==='ar') ? 'ar' : 'en';
  }

  /* ============================= STRINGS ============================= */
  const TXT = {
    en:{
      menuBtn:'📘 Learn to Play',
      stepOf:(a,b)=>`Step ${a} of ${b}`,
      back:'Back', next:'Next', skip:'Skip Tutorial', exit:'Exit', restart:'Restart Tutorial',
      exitConfirm:'Exit the tutorial? Your progress in this practice round will be lost.',
      exitConfirmYes:'Exit', exitConfirmNo:'Keep Going',
      s1title:'Welcome to ZHAIMER!',
      s1body:'Your goal is to finish the round with the lowest total value. Memory, observation, and timing will help you win.',
      s2title:'Memorize your cards',
      s2body:'Tap any two of your four cards to peek at them.',
      s2peeking:'Remember their positions — they\'ll flip back down in',
      s2done:'Good — try to remember where those two cards are.',
      s3title:'Draw a card',
      s3body:'Tap the draw pile. Each turn you draw a card, then decide whether to exchange it with one of your hidden cards or discard it.',
      s4title:'Exchange or discard',
      s4bodyExchange:'This drawn card is lower than one of your hidden cards. Tap your highlighted high card to swap it in.',
      s4bodyDiscard:'Now try the other option — tap "Discard" to place a drawn card straight onto the discard pile instead.',
      discardBtn:'Discard',
      s5title:'Card values',
      s5body:'A quick reference before we continue:',
      s5ace:'Ace', s5num:'2 – 9', s5redten:'10 ♥ / 10 ♦', s5blackten:'10 ♣ / 10 ♠', s5face:'J, Q, K',
      s5aceV:'1 point', s5numV:'Printed value', s5redtenV:'0 points', s5blacktenV:'10 points', s5faceV:'10 points',
      s6title:'Special cards',
      s6king:'King — draw two cards and choose how to use them.',
      s6queen:'Queen — reveal one hidden card.',
      s6jack:'Jack — swap one card with an opponent, unseen by anyone.',
      s6tryKing:'Try it: tap the King to draw two cards.',
      s6tryQueen:'Try it: tap the Queen to peek at a hidden card.',
      s6tryJack:'Try it: tap the Jack to swap a card secretly.',
      s6kingDrew:'You drew two cards — pick one to use.',
      s6queenPeek:'Only you can see this — it flips back down automatically.',
      s6jackDone:'Swapped! No one — not even you — saw the final card.',
      s7title:'Burning matching cards',
      s7body:'If two cards have the same number, they can be burned. Tap your two matching cards.',
      s7burned:'Burned! Both cards are gone — one less card to worry about.',
      s8title:'Incorrect burn penalty',
      s8body:'Now let\'s try a burn that doesn\'t match.',
      s8penalty:'If your attempted burn does not match, the cards return and you must draw two penalty cards.',
      s8done:'The cards returned, and two penalty cards were added to your hand.',
      s9title:'Finish the round',
      s9body:'When you believe your hidden-card total is the lowest, declare Finished. Every other player receives one final turn, then all cards are revealed and the scores are calculated.',
      s9tap:'Tap "Finish" to try it.',
      completeTitle:'Tutorial Complete',
      completeBody:'You\'re ready to play ZHAIMER!',
      playAI:'Play vs AI', repeat:'Repeat Tutorial',
      wrongHint:'Try the highlighted card or button instead.',
      inviteTitle:'New to ZHAIMER?',
      inviteBody:'Learn the rules with a quick guided practice round.',
      inviteStart:'Start Tutorial', inviteLater:'Maybe Later',
    },
    ar:{
      menuBtn:'📘 تعلّم طريقة اللعب',
      stepOf:(a,b)=>`الخطوة ${a} من ${b}`,
      back:'رجوع', next:'التالي', skip:'تخطي التعليم', exit:'خروج', restart:'إعادة التعليم',
      exitConfirm:'هل تريد الخروج من التعليم؟ سيضيع تقدمك في هذه الجولة التجريبية.',
      exitConfirmYes:'خروج', exitConfirmNo:'أكمل',
      s1title:'مرحبًا بك في ZHAIMER!',
      s1body:'هدفك إنهاء الجولة بأقل مجموع قيم. الذاكرة والملاحظة والتوقيت ستساعدك على الفوز.',
      s2title:'احفظ أوراقك',
      s2body:'اضغط على أي ورقتين من أوراقك الأربع لمشاهدتهما.',
      s2peeking:'تذكّر مكانهما — سترجعان مقلوبتين بعد',
      s2done:'ممتاز — حاول تذكّر مكان هاتين الورقتين.',
      s3title:'اسحب ورقة',
      s3body:'اضغط على كومة السحب. في كل دور تسحب ورقة، ثم تقرر تبديلها بورقة مخفية أو التخلص منها.',
      s4title:'تبديل أو تخلص',
      s4bodyExchange:'هذه الورقة المسحوبة أقل من إحدى أوراقك المخفية. اضغط على ورقتك العالية المميزة لتبديلها.',
      s4bodyDiscard:'جرّب الخيار الآخر الآن — اضغط "تخلص" لوضع الورقة المسحوبة في كومة الرمي مباشرة.',
      discardBtn:'تخلص',
      s5title:'قيم الأوراق',
      s5body:'مرجع سريع قبل أن نكمل:',
      s5ace:'الآص', s5num:'2 – 9', s5redten:'10 ♥ / 10 ♦', s5blackten:'10 ♣ / 10 ♠', s5face:'J, Q, K',
      s5aceV:'نقطة واحدة', s5numV:'القيمة المطبوعة', s5redtenV:'0 نقطة', s5blacktenV:'10 نقاط', s5faceV:'10 نقاط',
      s6title:'الأوراق الخاصة',
      s6king:'الملك — اسحب ورقتين واختر كيف تستخدمهما.',
      s6queen:'الملكة — اكشف ورقة مخفية واحدة.',
      s6jack:'الولد — بدّل ورقة مع خصم دون أن يراها أحد.',
      s6tryKing:'جرّب: اضغط على الملك لسحب ورقتين.',
      s6tryQueen:'جرّب: اضغط على الملكة لمشاهدة ورقة مخفية.',
      s6tryJack:'جرّب: اضغط على الولد لتبديل ورقة سرًا.',
      s6kingDrew:'سحبت ورقتين — اختر واحدة لاستخدامها.',
      s6queenPeek:'أنت فقط تراها — سترجع مقلوبة تلقائيًا.',
      s6jackDone:'تم التبديل! لا أحد — ولا حتى أنت — رأى الورقة النهائية.',
      s7title:'حرق الأوراق المتطابقة',
      s7body:'إذا تطابق رقما ورقتين يمكن حرقهما. اضغط على ورقتيك المتطابقتين.',
      s7burned:'احترقتا! اختفت الورقتان — ورقة أقل تقلق بشأنها.',
      s8title:'عقوبة الحرق الخاطئ',
      s8body:'الآن جرّب حرقًا لا يتطابق.',
      s8penalty:'إذا لم تتطابق محاولة الحرق، ترجع الأوراق ويجب عليك سحب ورقتين عقابيتين.',
      s8done:'رجعت الأوراق، وأُضيفت ورقتان عقابيتان إلى يدك.',
      s9title:'إنهاء الجولة',
      s9body:'عندما تعتقد أن مجموع أوراقك المخفية هو الأقل، أعلن "إنهاء". يحصل كل لاعب آخر على دور أخير، ثم تُكشف كل الأوراق وتُحسب النقاط.',
      s9tap:'اضغط "إنهاء" لتجربتها.',
      completeTitle:'اكتمل التعليم',
      completeBody:'أنت جاهز للعب ZHAIMER!',
      playAI:'العب ضد الذكاء الاصطناعي', repeat:'إعادة التعليم',
      wrongHint:'جرّب الورقة أو الزر المميز بدلاً من ذلك.',
      inviteTitle:'جديد على ZHAIMER؟',
      inviteBody:'تعلّم القواعد بجولة تدريبية سريعة موجّهة.',
      inviteStart:'ابدأ التعليم', inviteLater:'ربما لاحقًا',
    }
  };
  function tt(key, ...args){
    const dict = TXT[curLang()] || TXT.en;
    const v = dict[key] !== undefined ? dict[key] : TXT.en[key];
    return typeof v === 'function' ? v(...args) : v;
  }

  /* ============================= STATE ============================= */
  const TOTAL_STEPS = 9;
  let TUT = null; // null when tutorial isn't open
  function freshState(){
    return {
      step:1,
      hand:[
        {rank:'K', suit:'♠', faceUp:false},
        {rank:'3', suit:'♥', faceUp:false},
        {rank:'10', suit:'♥', faceUp:false},
        {rank:'7', suit:'♦', faceUp:false},
      ],
      peeked:[],           // slots revealed in step 2
      peekCountdown:4,
      peekTimer:null,
      drawnCard:null,
      discardTop:{rank:'9', suit:'♣'},
      s4phase:'exchange',  // 'exchange' -> 'discard'
      s6phase:'king',      // king -> queen -> jack
      s6kingDraw:null,
      s6queenSlot:null,
      s7burnSelected:[],
      s8phase:'attempt',   // attempt -> penalty
      wrongFlashTarget:null,
      lastFocused:null,
    };
  }

  /* ============================= CARD RENDER ============================= */
  function renderCard(card, opts){
    opts = opts || {};
    const extra = opts.extraClass || '';
    if(!card || card.faceUp === false){
      return `<div class="card faceDown ${extra}" data-tut-slot="${opts.slot!=null?opts.slot:''}"></div>`;
    }
    const red = isRed(card.suit);
    return `<div class="card faceUp ${red?'red':''} ${extra}" data-tut-slot="${opts.slot!=null?opts.slot:''}">
      <div class="rank">${card.rank}</div>
      <div class="suit">${card.suit}</div>
      <div class="valchip">${cardValueFn(card)}</div>
    </div>`;
  }

  /* ============================= DOM SCAFFOLD ============================= */
  let root, panel, focusables = [];

  function ensureDom(){
    if(root) return;
    root = document.createElement('div');
    root.className = 'tut-overlay';
    root.setAttribute('hidden','');
    root.setAttribute('role','presentation');
    root.innerHTML = `<div class="tut-panel" role="dialog" aria-modal="true" aria-labelledby="tutTitle">
      <button class="tut-close-x" data-tut="requestExit" aria-label="${tt('exit')}">✕</button>
      <div class="tut-progress">
        <span data-tut-progress-text></span>
        <span class="tut-progress-track"><span class="tut-progress-fill" data-tut-progress-fill></span></span>
      </div>
      <div class="tut-stage" data-tut-stage></div>
      <div class="tut-controls">
        <div class="tut-controls-left">
          <button class="tut-btn tut-ghost" data-tut="back">${tt('back')}</button>
          <button class="tut-btn tut-ghost" data-tut="restart">${tt('restart')}</button>
        </div>
        <div class="tut-controls-right">
          <button class="tut-btn tut-ghost" data-tut="skip">${tt('skip')}</button>
          <button class="tut-btn tut-primary" data-tut="next">${tt('next')}</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(root);
    root.addEventListener('click', onRootClick);
    document.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e){
    if(!TUT || root.hasAttribute('hidden')) return;
    if(e.key === 'Escape'){ e.preventDefault(); requestExit(); return; }
    if(e.key === 'Tab'){ trapFocus(e); }
  }

  function trapFocus(e){
    focusables = Array.from(panel.querySelectorAll('button, [tabindex="0"]')).filter(el=>!el.disabled && el.offsetParent !== null);
    if(!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length-1];
    if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  }

  function onRootClick(e){
    const t2 = e.target.closest('[data-tut]');
    const slotEl = e.target.closest('[data-tut-slot]');
    if(t2){
      const action = t2.dataset.tut;
      if(action==='back') goBack();
      else if(action==='next') goNext();
      else if(action==='skip') requestSkip();
      else if(action==='restart') restart();
      else if(action==='requestExit') requestExit();
      else if(action==='confirmExitYes') closeTutorial(false);
      else if(action==='confirmExitNo') render();
      else handleStepAction(action, t2);
      return;
    }
    if(slotEl && slotEl.dataset.tutSlot !== ''){
      handleSlotClick(parseInt(slotEl.dataset.tutSlot,10), slotEl);
    }
  }

  /* ============================= FLOW CONTROL ============================= */
  function start(){
    ensureDom();
    TUT = freshState();
    TUT.lastFocused = document.activeElement;
    root.removeAttribute('hidden');
    render();
    setTimeout(()=>{ const f = panel.querySelector('.tut-btn.tut-primary'); if(f) f.focus(); }, 30);
  }

  function restart(){
    if(TUT && TUT.peekTimer) clearInterval(TUT.peekTimer);
    TUT = freshState();
    render();
  }

  function requestSkip(){ closeTutorial(false); }

  function requestExit(){
    if(!TUT) return;
    panel = root.querySelector('.tut-panel');
    const stage = panel.querySelector('[data-tut-stage]');
    stage.innerHTML = `<div class="tut-speech"><h3>${tt('exit')}?</h3><p>${tt('exitConfirm')}</p></div>
      <div style="display:flex; gap:10px; margin-top:6px;">
        <button class="tut-btn tut-ghost" data-tut="confirmExitNo">${tt('exitConfirmNo')}</button>
        <button class="tut-btn tut-primary" data-tut="confirmExitYes">${tt('exitConfirmYes')}</button>
      </div>`;
    panel.querySelector('.tut-controls').style.display = 'none';
    panel.querySelector('.tut-progress').style.display = 'none';
  }

  function closeTutorial(completed){
    if(TUT && TUT.peekTimer) clearInterval(TUT.peekTimer);
    if(completed){ storageSet(STORAGE_DONE, '1'); }
    TUT = null;
    if(root){ root.setAttribute('hidden',''); }
    const lastFocused = TUT && TUT.lastFocused;
    if(lastFocused && lastFocused.focus) { try{ lastFocused.focus(); }catch(e){} }
  }

  function goNext(){
    if(!TUT) return;
    if(TUT.step >= TOTAL_STEPS){ finishFlow(); return; }
    TUT.step += 1;
    render();
  }
  function goBack(){
    if(!TUT || TUT.step<=1) return;
    TUT.step -= 1;
    render();
  }

  function finishFlow(){
    panel.querySelector('.tut-controls').style.display = 'none';
    const stage = panel.querySelector('[data-tut-stage]');
    stage.innerHTML = `<div class="tut-speech">
        <h3>🎉 ${tt('completeTitle')}</h3>
        <p>${tt('completeBody')}</p>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="tut-btn tut-primary" data-tut="playAI">${tt('playAI')}</button>
        <button class="tut-btn tut-ghost" data-tut="repeat">${tt('repeat')}</button>
      </div>`;
    stage.querySelector('[data-tut="playAI"]').addEventListener('click', ()=>{
      closeTutorial(true);
      if(typeof window.goAISetup === 'function'){ window.goAISetup(); if(typeof window.render==='function') window.render(); }
    });
    stage.querySelector('[data-tut="repeat"]').addEventListener('click', restart);
    storageSet(STORAGE_DONE, '1');
    panel.querySelector('.tut-progress').style.display = 'none';
  }

  /* ============================= STEP-SPECIFIC ACTIONS ============================= */
  function flashWrong(el){
    if(!el) return;
    el.classList.add('tut-wrong-click');
    setTimeout(()=>el.classList.remove('tut-wrong-click'), 350);
  }

  function handleSlotClick(slot, el){
    if(!TUT) return;
    if(TUT.step === 2){
      if(TUT.peeked.length >= 2 || TUT.peeked.includes(slot)) { return; }
      TUT.peeked.push(slot);
      TUT.hand[slot].faceUp = true;
      render();
      if(TUT.peeked.length === 2){
        TUT.peekCountdown = 4;
        TUT.peekTimer = setInterval(()=>{
          TUT.peekCountdown -= 1;
          updateCountdownUI();
          if(TUT.peekCountdown <= 0){
            clearInterval(TUT.peekTimer);
            TUT.peeked.forEach(s=>{ TUT.hand[s].faceUp = false; });
            render();
          }
        }, 1000);
      }
      return;
    }
    if(TUT.step === 4 && TUT.s4phase === 'exchange'){
      if(slot === 0){ // K♠ is the required high card at slot 0
        TUT.hand[0] = Object.assign({}, TUT.drawnCard || {rank:'2', suit:'♦'}, {faceUp:false});
        TUT.drawnCard = null;
        TUT.s4phase = 'discardIntro';
        render();
      } else {
        flashWrong(document.querySelector('[data-tut-slot="0"]'));
      }
      return;
    }
    if(TUT.step === 6 && TUT.s6phase === 'queenPick'){
      TUT.s6queenSlot = slot;
      TUT.hand[slot].faceUp = true;
      render();
      setTimeout(()=>{
        TUT.hand[slot].faceUp = false;
        TUT.s6phase = 'queenPeeked';
        render();
      }, 1600);
      return;
    }
    if(TUT.step === 7){
      if(TUT.s7burnSelected.includes(slot)) return;
      // predetermined matching pair lives at slots 2 & 3 (both value-matching 10♥ set up dynamically)
      TUT.s7burnSelected.push(slot);
      render();
      if(TUT.s7burnSelected.length === 2){
        setTimeout(()=>{
          TUT.s7burnSelected = [];
          TUT.hand = TUT.hand.filter((_,i)=> i!==2 && i!==3);
          render();
        }, 700);
      }
      return;
    }
  }

  function updateCountdownUI(){
    const el = panel && panel.querySelector('[data-tut-countdown]');
    if(el) el.textContent = TUT.peekCountdown;
  }

  function handleStepAction(action, el){
    if(!TUT) return;
    if(TUT.step === 3 && action === 'draw'){
      TUT.drawnCard = {rank:'2', suit:'♦', faceUp:true};
      TUT.step = 4; TUT.s4phase = 'exchange';
      render();
      return;
    }
    if(TUT.step === 4){
      if(action === 'discard'){
        if(TUT.s4phase === 'discardIntro'){
          TUT.drawnCard = null;
          render();
          setTimeout(goNext, 500);
        }
        return;
      }
    }
    if(TUT.step === 6){
      if(action === 'pickKing'){
        TUT.s6kingDraw = [{rank:'4',suit:'♣'},{rank:'9',suit:'♦'}];
        TUT.s6phase = 'kingPick';
        render(); return;
      }
      if(action === 'kingUse'){
        TUT.s6kingDraw = null;
        TUT.s6phase = 'queen';
        render(); return;
      }
      if(action === 'pickQueen'){
        TUT.s6phase = 'queenPick';
        render(); return;
      }
      if(action === 'queenContinue'){
        TUT.s6phase = 'jack';
        render(); return;
      }
      if(action === 'pickJack'){
        TUT.s6phase = 'jackDone';
        render(); return;
      }
    }
    if(TUT.step === 8){
      if(action === 'attemptBurn'){
        TUT.s8phase = 'penalty';
        render();
        return;
      }
      if(action === 'ackPenalty'){
        TUT.hand.push({rank:'5',suit:'♣',faceUp:false},{rank:'8',suit:'♠',faceUp:false});
        setTimeout(goNext, 200);
        return;
      }
    }
    if(TUT.step === 9 && action === 'finishDeclare'){
      const stage = panel.querySelector('[data-tut-stage]');
      const speech = stage.querySelector('.tut-speech p');
      if(speech) speech.textContent = tt('completeBody');
      setTimeout(goNext, 500);
      return;
    }
  }

  /* ============================= STEP RENDERERS ============================= */
  function stepBody(){
    switch(TUT.step){
      case 1: return step1();
      case 2: return step2();
      case 3: return step3();
      case 4: return step4();
      case 5: return step5();
      case 6: return step6();
      case 7: return step7();
      case 8: return step8();
      case 9: return step9();
      default: return '';
    }
  }

  function step1(){
    return `<div class="tut-speech"><h3>${tt('s1title')}</h3><p>${tt('s1body')}</p></div>
      <div class="tut-mini-cards">
        ${TUT.hand.map((c,i)=>renderCard(c,{slot:i})).join('')}
      </div>`;
  }

  function step2(){
    const peeking = TUT.peeked.length === 2 && TUT.peekTimer;
    return `<div class="tut-speech"><h3>${tt('s2title')}</h3><p>${peeking ? `${tt('s2peeking')} <span class="tut-countdown" data-tut-countdown>${TUT.peekCountdown}</span>s` : (TUT.peeked.length===2 ? tt('s2done') : tt('s2body'))}</p></div>
      <div class="tut-mini-cards tut-spot">
        ${TUT.hand.map((c,i)=>renderCard(c,{slot:i, extraClass: (!TUT.hand[i].faceUp && TUT.peeked.length<2 && !TUT.peeked.includes(i)) ? 'clickable' : ''})).join('')}
      </div>`;
  }

  function step3(){
    return `<div class="tut-speech"><h3>${tt('s3title')}</h3><p>${tt('s3body')}</p></div>
      <div class="tut-mini-cards">
        <div class="tut-spot"><div class="card faceDown clickable" data-tut="draw"></div></div>
      </div>`;
  }

  function step4(){
    if(TUT.s4phase === 'exchange'){
      return `<div class="tut-speech"><h3>${tt('s4title')}</h3><p>${tt('s4bodyExchange')}</p></div>
        <div class="tut-mini-cards">
          <div class="tut-spot">${renderCard(TUT.hand[0], {slot:0, extraClass:'clickable'})}</div>
          ${renderCard(TUT.drawnCard, {extraClass:'big'})}
        </div>`;
    }
    return `<div class="tut-speech"><h3>${tt('s4title')}</h3><p>${tt('s4bodyDiscard')}</p></div>
      <div class="tut-mini-cards">
        ${renderCard({rank:'6',suit:'♣',faceUp:true},{extraClass:'big'})}
        <button class="tut-btn tut-primary" data-tut="discard">${tt('discardBtn')}</button>
      </div>`;
  }

  function step5(){
    return `<div class="tut-speech"><h3>${tt('s5title')}</h3><p>${tt('s5body')}</p></div>
      <div class="tut-values-panel">
        <div><span>${tt('s5ace')}</span><b>${tt('s5aceV')}</b></div>
        <div><span>${tt('s5num')}</span><b>${tt('s5numV')}</b></div>
        <div><span>${tt('s5redten')}</span><b>${tt('s5redtenV')}</b></div>
        <div><span>${tt('s5blackten')}</span><b>${tt('s5blacktenV')}</b></div>
        <div><span>${tt('s5face')}</span><b>${tt('s5faceV')}</b></div>
      </div>`;
  }

  function step6(){
    let body, cardsHtml;
    switch(TUT.s6phase){
      case 'king':
        body = `<h3>${tt('s6title')}</h3><p>${tt('s6king')}</p><p>${tt('s6tryKing')}</p>`;
        cardsHtml = renderCard({rank:'K',suit:'♦',faceUp:true},{extraClass:'big'});
        return `<div class="tut-speech">${body}</div><div class="tut-mini-cards"><span data-tut="pickKing" style="cursor:pointer;">${cardsHtml}</span></div>`;
      case 'kingPick':
        body = `<h3>${tt('s6title')}</h3><p>${tt('s6kingDrew')}</p>`;
        cardsHtml = TUT.s6kingDraw.map(c=>renderCard(Object.assign({},c,{faceUp:true}),{extraClass:'big'})).join('');
        return `<div class="tut-speech">${body}</div>
          <div class="tut-mini-cards">${cardsHtml}</div>
          <button class="tut-btn tut-primary" data-tut="kingUse">${tt('next')}</button>`;
      case 'queen':
        return `<div class="tut-speech"><h3>${tt('s6title')}</h3><p>${tt('s6queen')}</p><p>${tt('s6tryQueen')}</p></div>
          <div class="tut-mini-cards">${renderCard({rank:'Q',suit:'♥',faceUp:true},{extraClass:'big'})}</div>
          <button class="tut-btn tut-primary" data-tut="pickQueen">${tt('next')}</button>`;
      case 'queenPick':
        return `<div class="tut-speech"><h3>${tt('s6title')}</h3><p>${tt('s6tryQueen')}</p></div>
          <div class="tut-mini-cards tut-spot">
            ${TUT.hand.map((c,i)=>renderCard(c,{slot:i, extraClass:'clickable'})).join('')}
          </div>`;
      case 'queenPeeked':
        return `<div class="tut-speech"><h3>${tt('s6title')}</h3><p>${tt('s6queenPeek')}</p></div>
          <button class="tut-btn tut-primary" data-tut="queenContinue">${tt('next')}</button>`;
      case 'jack':
        return `<div class="tut-speech"><h3>${tt('s6title')}</h3><p>${tt('s6jack')}</p><p>${tt('s6tryJack')}</p></div>
          <div class="tut-mini-cards">${renderCard({rank:'J',suit:'♠',faceUp:true},{extraClass:'big'})}</div>
          <button class="tut-btn tut-primary" data-tut="pickJack">${tt('next')}</button>`;
      case 'jackDone':
        return `<div class="tut-speech"><h3>${tt('s6title')}</h3><p>${tt('s6jackDone')}</p></div>`;
      default:
        return '';
    }
  }

  function step7(){
    // ensure the two burnable red-ten cards exist at slots 2 & 3 for this step
    if(TUT.hand.length >= 4 && !(TUT.hand[2].rank==='10' && TUT.hand[3].rank==='10')){
      TUT.hand[2] = {rank:'10', suit:'♥', faceUp:true};
      TUT.hand[3] = {rank:'10', suit:'♦', faceUp:true};
    }
    return `<div class="tut-speech"><h3>${tt('s7title')}</h3><p>${TUT.hand.length<4 ? tt('s7burned') : tt('s7body')}</p></div>
      <div class="tut-mini-cards tut-burn-fx tut-spot">
        ${TUT.hand.map((c,i)=>renderCard(c,{slot:i, extraClass: (i===2||i===3) ? 'clickable'+(TUT.s7burnSelected.includes(i)?' burning':'') : ''})).join('')}
      </div>`;
  }

  function step8(){
    if(TUT.s8phase === 'attempt'){
      return `<div class="tut-speech"><h3>${tt('s8title')}</h3><p>${tt('s8body')}</p></div>
        <div class="tut-mini-cards">
          ${renderCard({rank:'4',suit:'♣',faceUp:true},{extraClass:'big'})}
          ${renderCard({rank:'9',suit:'♠',faceUp:true},{extraClass:'big'})}
        </div>
        <button class="tut-btn tut-primary" data-tut="attemptBurn">${tt('next')}</button>`;
    }
    return `<div class="tut-speech"><h3>${tt('s8title')}</h3><p>${tt('s8penalty')}</p><p>${tt('s8done')}</p></div>
      <button class="tut-btn tut-primary" data-tut="ackPenalty">${tt('next')}</button>`;
  }

  function step9(){
    const finishLabel = curLang()==='ar' ? 'إنهاء' : 'Finish';
    return `<div class="tut-speech"><h3>${tt('s9title')}</h3><p>${tt('s9body')}</p><p>${tt('s9tap')}</p></div>
      <div class="tut-spot" style="display:inline-block;">
        <button class="tut-btn tut-primary" data-tut="finishDeclare">${finishLabel}</button>
      </div>`;
  }

  /* ============================= MASTER RENDER ============================= */
  function render(){
    if(!TUT || !root) return;
    panel = root.querySelector('.tut-panel');
    panel.querySelector('[data-tut-progress-text]').textContent = tt('stepOf', TUT.step, TOTAL_STEPS);
    panel.querySelector('[data-tut-progress-fill]').style.width = ((TUT.step/TOTAL_STEPS)*100) + '%';
    panel.querySelector('.tut-controls').style.display = '';
    panel.querySelector('.tut-progress').style.display = '';
    const stage = panel.querySelector('[data-tut-stage]');
    stage.innerHTML = stepBody();

    const backBtn = panel.querySelector('[data-tut="back"]');
    const nextBtn = panel.querySelector('[data-tut="next"]');
    if(backBtn) backBtn.disabled = (TUT.step <= 1);
    if(nextBtn){
      nextBtn.textContent = (TUT.step >= TOTAL_STEPS) ? tt('next') : tt('next');
      nextBtn.disabled = stepBlocksNext();
    }
  }

  // Steps that require a specific interaction before "Next" is allowed
  function stepBlocksNext(){
    switch(TUT.step){
      case 2: return TUT.peeked.length < 2 || !!TUT.peekTimer;
      case 3: return true; // must click draw pile, which auto-advances
      case 4: return true; // advanced via drag/exchange or discard button, not Next
      case 6: return TUT.s6phase !== 'jackDone';
      case 7: return TUT.hand.length >= 4;
      case 8: return true; // advanced via attemptBurn/ackPenalty buttons, not Next
      case 9: return true; // advanced via finishDeclare
      default: return false;
    }
  }

  /* ============================= INVITE PROMPT ============================= */
  function maybeShowInvite(){
    if(storageGet(STORAGE_DONE) === '1') return;
    if(storageGet(STORAGE_INVITE_SEEN) === '1') return;
    const el = document.createElement('div');
    el.className = 'tut-invite';
    el.innerHTML = `<strong>${tt('inviteTitle')}</strong>
      <span>${tt('inviteBody')}</span>
      <div class="tut-invite-actions">
        <button class="tut-btn tut-ghost" data-tut-invite="later">${tt('inviteLater')}</button>
        <button class="tut-btn tut-primary" data-tut-invite="start">${tt('inviteStart')}</button>
      </div>`;
    document.body.appendChild(el);
    storageSet(STORAGE_INVITE_SEEN, '1');
    el.addEventListener('click', (e)=>{
      const b = e.target.closest('[data-tut-invite]');
      if(!b) return;
      el.remove();
      if(b.dataset.tutInvite === 'start') start();
    });
    setTimeout(()=>{ if(el.parentNode) el.remove(); }, 15000);
  }

  window.ZhaimerTutorial = {
    start: start,
    maybeShowInvite: maybeShowInvite,
    isDone: function(){ return storageGet(STORAGE_DONE) === '1'; },
  };
})();
