/**
 * SortBar — shared sort logic for list.html and section/local.html.
 * Supports both flat (post-entry) and tree (ptree-article) views.
 *
 * Usage: set window.SortBarConfig BEFORE including this script,
 * then call SortBar.init().
 */
(function () {
  var bar = document.querySelector('.sort-bar');
  if (!bar) return;

  var cfg = window.SortBarConfig || {};
  var defaults = cfg.defaults || { name: 'asc', date: 'desc', lastmod: 'desc' };
  var labels = { name: '按名称', date: '按日期', lastmod: '按修改日期' };
  var storageKey = cfg.storageKey || 'blog_sort';

  var treeWrap = document.querySelector('.post-tree-wrap');
  var isTree = !!treeWrap;
  var btns = bar.querySelectorAll('.sort-btn');

  function updateBtns(mode, dir) {
    btns.forEach(function (btn) {
      var m = btn.dataset.sort;
      btn.classList.toggle('active', m === mode);
      btn.textContent = m === mode ? labels[m] + (dir === 'asc' ? ' ↑' : ' ↓') : labels[m];
    });
  }

  /* ── Flat mode sort ── */
  function getFlatArticles() {
    var sel = cfg.flatSelector || '.post-entry';
    return Array.from(document.querySelectorAll(sel));
  }

  function sortFlat(mode, dir) {
    var articles = getFlatArticles();
    articles.sort(function (a, b) {
      var cmp;
      if (mode === 'name')
        cmp = (a.dataset.sortTitle || '').localeCompare(b.dataset.sortTitle || '');
      else if (mode === 'lastmod')
        cmp = (a.dataset.sortLastmod || '').localeCompare(b.dataset.sortLastmod || '');
      else cmp = (a.dataset.sortDate || '').localeCompare(b.dataset.sortDate || '');
      return dir === 'asc' ? cmp : -cmp;
    });
    var ref = bar.nextElementSibling;
    articles.forEach(function (el) { el.parentNode.insertBefore(el, ref); });
  }

  function updateFlatDates(mode) {
    getFlatArticles().forEach(function (el) {
      var span = el.querySelector('.entry-date');
      if (!span) return;
      var val = mode === 'lastmod' ? el.dataset.sortLastmod : el.dataset.sortDate;
      if (val) {
        if (cfg.formatDate) span.textContent = cfg.formatDate(val);
        else span.textContent = val;
      }
    });
  }

  /* ── Tree mode sort ── */
  function getTreeArticles(folderEl) {
    var root = folderEl || treeWrap;
    return Array.from(root.querySelectorAll('.ptree-article'));
  }

  function sortTreeArticles(container, mode, dir) {
    var articles = getTreeArticles(container);
    articles.sort(function (a, b) {
      var linkA = a.querySelector('.ptree-link');
      var linkB = b.querySelector('.ptree-link');
      var titleA = (linkA ? linkA.querySelector('.ptree-title') : null);
      var titleB = (linkB ? linkB.querySelector('.ptree-title') : null);
      var dateA = (linkA ? linkA.querySelector('.ptree-date') : null);
      var dateB = (linkB ? linkB.querySelector('.ptree-date') : null);
      var cmp;
      if (mode === 'name')
        cmp = (titleA ? titleA.textContent : '').localeCompare(titleB ? titleB.textContent : '');
      else if (mode === 'lastmod')
        cmp = (dateA ? dateA.textContent : '').localeCompare(dateB ? dateB.textContent : '');
      else cmp = (dateA ? dateA.textContent : '').localeCompare(dateB ? dateB.textContent : '');
      return dir === 'asc' ? cmp : -cmp;
    });
    if (!articles.length) return;
    var list = articles[0].parentNode;
    var ref = null;
    for (var i = 0; i < list.children.length; i++) {
      if (!list.children[i].classList.contains('ptree-article')) {
        if (articles.indexOf(list.children[i]) === -1) { ref = list.children[i]; break; }
      }
    }
    articles.forEach(function (el) { list.insertBefore(el, ref); });
  }

  function sortAllTrees(mode, dir) {
    var lists = treeWrap.querySelectorAll('.ptree-list');
    for (var i = 0; i < lists.length; i++) sortTreeArticles(lists[i], mode, dir);
  }

  /* ── Init ── */
  var savedRaw = sessionStorage.getItem(storageKey) || cfg.defaultKey || 'date_desc';
  var parts = savedRaw.split('_');
  var curMode = (parts[0] in defaults) ? parts[0] : Object.keys(defaults)[0];
  var curDir = (parts[1] === 'asc' || parts[1] === 'desc') ? parts[1] : defaults[curMode];

  btns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.dataset.sort;
      curDir = (mode === curMode) ? (curDir === 'asc' ? 'desc' : 'asc') : defaults[mode];
      curMode = mode;
      sessionStorage.setItem(storageKey, curMode + '_' + curDir);
      if (isTree) sortAllTrees(curMode, curDir);
      else { sortFlat(curMode, curDir); updateFlatDates(curMode); }
      updateBtns(curMode, curDir);
    });
  });

  updateBtns(curMode, curDir);
  var initialOk = cfg.initial || { mode: 'date', dir: 'desc' };
  if (isTree && !(curMode === initialOk.mode && curDir === initialOk.dir)) sortAllTrees(curMode, curDir);
  else if (!isTree && !(curMode === initialOk.mode && curDir === initialOk.dir)) {
    sortFlat(curMode, curDir);
    updateFlatDates(curMode);
  }
})();
