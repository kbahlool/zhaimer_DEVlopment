/* =============================================================================
   ZHAIMER — Feedback widget behavior
   No backend, no external service. Ratings are stored to localStorage only
   (for the site owner to eyeball manually / read out later if desired);
   the report form just builds a mailto: link with device/browser prefilled.
   ============================================================================= */
(function(){
  'use strict';
  function storageSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function storageGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }

  document.addEventListener('DOMContentLoaded', function(){
    const ratingGroup = document.getElementById('feedbackRating');
    const thanks = document.getElementById('feedbackThanks');
    if(ratingGroup){
      ratingGroup.addEventListener('click', function(e){
        const btn = e.target.closest('.feedback-rating-btn');
        if(!btn) return;
        Array.from(ratingGroup.querySelectorAll('.feedback-rating-btn')).forEach(b=>b.classList.remove('selected'));
        btn.classList.add('selected');
        const rating = btn.dataset.rating;
        const log = JSON.parse(storageGet('zhaimer_feedback_log') || '[]');
        log.push({ rating: rating, at: new Date().toISOString() });
        storageSet('zhaimer_feedback_log', JSON.stringify(log));
        if(thanks) thanks.hidden = false;
      });
    }

    const deviceEl = document.getElementById('reportDevice');
    if(deviceEl){
      const ua = navigator.userAgent || 'Unknown device';
      deviceEl.textContent = 'Will be included automatically: ' + ua;
    }

    const form = document.getElementById('reportForm');
    if(form){
      form.addEventListener('submit', function(e){
        e.preventDefault();
        const desc = document.getElementById('reportDesc').value.trim();
        const ua = navigator.userAgent || 'Unknown';
        const body = [
          'Description:', desc || '(not provided)',
          '',
          'Device / Browser (automatically included):',
          ua,
          '',
          'Page: ' + location.href,
        ].join('\n');
        const mailto = 'mailto:labgameskmb@gmail.com'
          + '?subject=' + encodeURIComponent('Zhaimer — Problem Report')
          + '&body=' + encodeURIComponent(body);
        window.location.href = mailto;
      });
    }
  });
})();
