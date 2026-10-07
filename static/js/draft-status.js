(function () {
  'use strict';
  var script = document.currentScript;
  var hint = document.querySelector('.post-title .entry-hint');
  if (!hint || !script || !/^https?:$/.test(location.protocol)) return;
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'entry-hint draft-status-button';
  button.title = '移除草稿标记';
  button.setAttribute('aria-label', '移除草稿标记');
  button.innerHTML = hint.innerHTML;
  hint.replaceWith(button);
  var dialog = document.createElement('dialog');
  dialog.className = 'draft-status-dialog';
  dialog.setAttribute('aria-labelledby', 'draft-status-title');
  dialog.innerHTML = '<h2 id="draft-status-title">移除草稿标记？</h2><p class="draft-article-title"></p><p>确认后将移除当前文章源文件中的 draft = true。公开目录中的文章会被正式构建收录。</p><p role="status" class="draft-status-message"></p><div class="draft-status-actions"><button type="button" class="draft-cancel">取消</button><button type="button" class="draft-confirm">确认移除</button></div>';
  dialog.querySelector('.draft-article-title').textContent = document.querySelector('.post-title').textContent.trim();
  document.body.appendChild(dialog);
  var confirm = dialog.querySelector('.draft-confirm');
  var cancel = dialog.querySelector('.draft-cancel');
  var status = dialog.querySelector('.draft-status-message');
  var busy = false;
  button.addEventListener('click', function () { status.textContent = ''; dialog.showModal(); });
  cancel.addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('cancel', function (event) { if (busy) event.preventDefault(); });
  confirm.addEventListener('click', async function () {
    if (busy) return;
    busy = true;
    confirm.disabled = cancel.disabled = true;
    status.textContent = '正在移除草稿标记…';
    var service = script.getAttribute('data-service').replace(/\/$/, '');
    try {
      var response = await fetch(service + '/session', { cache: 'no-store' });
      var session = await response.json();
      if (!response.ok) throw new Error(session.error || '无法连接本地服务');
      if (!session.remove_draft) throw new Error('当前服务版本不支持移除草稿，请关闭预览窗口并重新运行启动预览脚本。');
      response = await fetch(service + '/remove-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GithubIO-Publish-Token': session.token },
        body: JSON.stringify({ article: script.getAttribute('data-article') })
      });
      var result = await response.json();
      if (!response.ok) throw new Error(result.error || '移除草稿失败');
      status.textContent = '已移除草稿标记，正在刷新文章…';
      setTimeout(function () { location.reload(); }, 1000);
    } catch (error) {
      status.textContent = error instanceof TypeError ? '无法连接本地服务，请运行启动预览脚本后重试。' : error.message;
      busy = false;
      confirm.disabled = cancel.disabled = false;
    }
  });
})();
