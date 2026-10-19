/* 测试预览版横幅：仅在 preview.html 里加载。
   正式版（index.html）不引用这个文件，所以正式页不会有这条横幅。 */
(function () {
  'use strict';

  function injectBar() {
    if (document.getElementById('preview-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'preview-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<span class="pb-tag">测试预览版</span>' +
      '<span class="pb-text">当前是待确认的测试版本，确认无误后才会更新到正式版</span>' +
      '<a class="pb-back" href="./index.html">返回正式版</a>';

    const css = document.createElement('style');
    css.textContent = [
      '#preview-bar{position:sticky;top:0;z-index:9999;display:flex;align-items:center;gap:8px;',
      'padding:9px 12px;background:#FFF4E2;border-bottom:1px solid #F5D9A8;color:#8A5A00;',
      'font-size:12px;line-height:1.4;flex-wrap:wrap}',
      '#preview-bar .pb-tag{background:#8A5A00;color:#fff;border-radius:6px;padding:1px 7px;',
      'font-size:11px;font-weight:700;white-space:nowrap;flex:none}',
      '#preview-bar .pb-text{flex:1;min-width:120px}',
      '#preview-bar .pb-back{color:#8A5A00;font-weight:600;text-decoration:underline;white-space:nowrap;flex:none}',
    ].join('');

    document.head.appendChild(css);
    document.body.prepend(bar);
  }

  // 设置弹窗里的入口按钮：在预览版里改成「返回正式版」
  function fixSettingsButton() {
    const btn = document.getElementById('go-preview');
    if (!btn) return;
    btn.textContent = '返回正式版';
    btn.setAttribute('href', './index.html');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { injectBar(); fixSettingsButton(); });
  } else {
    injectBar();
    fixSettingsButton();
  }
})();
