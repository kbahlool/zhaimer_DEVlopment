/* =============================================================================
   ZHAIMER — Achievements & Player Profile data layer
   -----------------------------------------------------------------------------
   Pure localStorage module, no dependency on game.js. Designed so that once
   you're ready, game.js only needs to call ZhaimerProfile.recordGameResult(...)
   once per finished match (real or AI) — everything else (streaks, win %,
   achievement unlocks) is computed here.

   STORAGE KEY: 'zhaimer_profile_v1'  (single JSON blob, versioned so future
   fields can be migrated safely)

   SCHEMA:
   {
     version: 1,
     displayName: string,
     avatar: string,            // emoji key, see AVATARS below
     gamesPlayed: number,
     gamesWon: number,
     bestScore: number|null,    // lowest final hand total ever achieved
     currentStreak: number,     // consecutive wins
     bestStreak: number,
     difficultyCounts: { easy:n, medium:n, hard:n },
     burnsSuccessful: number,
     burnsFailed: number,
     cardsRememberedCorrect: number,   // optional, filled in by future memory-report hook
     achievements: { [achievementId]: isoDateUnlocked },
     dailyChallenge: {
       lastPlayedDate: 'YYYY-MM-DD'|null,
       bestScore: number|null,
       streak: number
     }
   }
   ============================================================================= */
(function(){
  'use strict';

  const KEY = 'zhaimer_profile_v1';

  function storageGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function storageSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }

  function defaultProfile(){
    return {
      version: 1,
      displayName: '',
      avatar: '🧠',
      gamesPlayed: 0,
      gamesWon: 0,
      bestScore: null,
      currentStreak: 0,
      bestStreak: 0,
      difficultyCounts: { easy:0, medium:0, hard:0 },
      burnsSuccessful: 0,
      burnsFailed: 0,
      cardsRememberedCorrect: 0,
      achievements: {},
      dailyChallenge: { lastPlayedDate: null, bestScore: null, streak: 0 },
    };
  }

  function load(){
    const raw = storageGet(KEY);
    if(!raw) return defaultProfile();
    try{
      const parsed = JSON.parse(raw);
      // shallow-merge onto defaults so missing fields from older versions
      // (or a partially-written profile) never crash the UI
      return Object.assign(defaultProfile(), parsed, {
        difficultyCounts: Object.assign({easy:0,medium:0,hard:0}, parsed.difficultyCounts),
        achievements: Object.assign({}, parsed.achievements),
        dailyChallenge: Object.assign({lastPlayedDate:null,bestScore:null,streak:0}, parsed.dailyChallenge),
      });
    }catch(e){ return defaultProfile(); }
  }

  function save(profile){ storageSet(KEY, JSON.stringify(profile)); }

  /* ============================= ACHIEVEMENTS ============================= */
  const ACHIEVEMENTS = [
    { id:'first_victory', en:'First Victory', ar:'أول فوز', descEn:'Win your first match.', descAr:'اربح أول مباراة لك.', icon:'🏆' },
    { id:'perfect_memory', en:'Perfect Memory', ar:'ذاكرة مثالية', descEn:'Finish a round without a single incorrect exchange.', descAr:'أنهِ جولة دون أي تبديل خاطئ واحد.', icon:'🧠' },
    { id:'burn_master', en:'Burn Master', ar:'سيد الحرق', descEn:'Successfully burn 10 matching pairs across all games.', descAr:'احرق 10 أزواج متطابقة بنجاح عبر كل الألعاب.', icon:'🔥' },
    { id:'zero_point_finish', en:'Zero-Point Finish', ar:'إنهاء بصفر نقطة', descEn:'Finish a round with a total of 0 points.', descAr:'أنهِ جولة بمجموع 0 نقطة.', icon:'💎' },
    { id:'three_wins', en:'Three Wins', ar:'ثلاثة انتصارات', descEn:'Win 3 matches.', descAr:'اربح 3 مباريات.', icon:'🥉' },
    { id:'special_card_expert', en:'Special Card Expert', ar:'خبير الأوراق الخاصة', descEn:'Use a King, Queen, and Jack ability all in one match.', descAr:'استخدم قدرات الملك والملكة والولد في مباراة واحدة.', icon:'🃏' },
    { id:'tutorial_graduate', en:'Tutorial Graduate', ar:'خريج التعليم', descEn:'Complete the "Learn to Play" tutorial.', descAr:'أكمل تعليم "تعلّم طريقة اللعب".', icon:'📘' },
  ];

  function unlock(profile, id){
    if(!profile.achievements[id]){
      profile.achievements[id] = new Date().toISOString();
      return true; // newly unlocked
    }
    return false;
  }

  /* ============================= RECORDING RESULTS ============================= */
  // Call once per finished match. `result` shape (all optional except won/score):
  // { won:boolean, score:number, difficulty:'easy'|'medium'|'hard',
  //   burnsSuccessful:number, burnsFailed:number, noIncorrectExchanges:boolean,
  //   usedKing:boolean, usedQueen:boolean, usedJack:boolean }
  function recordGameResult(result){
    const p = load();
    p.gamesPlayed += 1;
    if(result.won){
      p.gamesWon += 1;
      p.currentStreak += 1;
      p.bestStreak = Math.max(p.bestStreak, p.currentStreak);
    } else {
      p.currentStreak = 0;
    }
    if(typeof result.score === 'number'){
      p.bestScore = (p.bestScore === null) ? result.score : Math.min(p.bestScore, result.score);
      if(result.score === 0) unlock(p, 'zero_point_finish');
    }
    if(result.difficulty && p.difficultyCounts[result.difficulty] !== undefined){
      p.difficultyCounts[result.difficulty] += 1;
    }
    p.burnsSuccessful += result.burnsSuccessful || 0;
    p.burnsFailed += result.burnsFailed || 0;

    if(result.won) unlock(p, 'first_victory');
    if(p.gamesWon >= 3) unlock(p, 'three_wins');
    if(p.burnsSuccessful >= 10) unlock(p, 'burn_master');
    if(result.noIncorrectExchanges) unlock(p, 'perfect_memory');
    if(result.usedKing && result.usedQueen && result.usedJack) unlock(p, 'special_card_expert');

    save(p);
    return p;
  }

  function markTutorialComplete(){
    const p = load();
    unlock(p, 'tutorial_graduate');
    save(p);
    return p;
  }

  function favoriteDifficulty(profile){
    const d = profile.difficultyCounts;
    const entries = Object.entries(d);
    entries.sort((a,b)=>b[1]-a[1]);
    return entries[0][1] > 0 ? entries[0][0] : null;
  }

  function winPercent(profile){
    if(profile.gamesPlayed === 0) return 0;
    return Math.round((profile.gamesWon / profile.gamesPlayed) * 100);
  }

  window.ZhaimerProfile = {
    load, save, defaultProfile,
    recordGameResult, markTutorialComplete,
    ACHIEVEMENTS, favoriteDifficulty, winPercent,
  };
})();
