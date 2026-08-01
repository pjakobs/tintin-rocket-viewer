// Mobile chrome: on narrow screens the HUD stats panel and the bottom sliders
// default to collapsed (see the index.html media query) so they don't crowd
// out the model. These toggles just flip an `open` class — independent of the
// 3D scene, so this can run before the model has loaded.
export function initPanels() {
  const hud = document.getElementById('hud');
  const hudToggle = document.getElementById('hud-toggle');
  const hudClose = document.getElementById('hud-close');
  hudToggle.addEventListener('click', () => {
    hud.classList.add('open');
    hudToggle.classList.add('gone');
  });
  hudClose.addEventListener('click', () => {
    hud.classList.remove('open');
    hudToggle.classList.remove('gone');
  });

  const sliders = document.getElementById('controls-sliders');
  const slidersToggle = document.getElementById('controls-toggle');
  slidersToggle.addEventListener('click', () => sliders.classList.toggle('open'));
}
