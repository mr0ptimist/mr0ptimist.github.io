# scripts/cdp — 列表页树形视图回归检查
#
# 从 Hugo 构建出的 HTML 提取「服务端渲染的期望结构」：每个 <ul class="ptree-list">
# （用所在文件夹链做 key）的直属文章标题列表。tree_check.js / order_check.js 拿它
# 和浏览器执行 JS 之后的 DOM 对比。
#
# 用法：python scripts/cdp/parse_expected.py <.tmp-localcheck/local/index.html> <out.json>
import json, sys
from html.parser import HTMLParser


class TreeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.folder_stack = []   # 当前打开的 <details> 文件夹名（层级链）
        self.ul_stack = []       # 嵌套的 ptree-list 条目
        self.results = []
        self.span_flags = []     # 每个打开的 <span>：'name' | 'title' | None
        self.buf = []

    def handle_starttag(self, tag, attrs):
        cls = dict(attrs).get('class', '') or ''
        if tag == 'details' and 'ptree-details' in cls:
            self.folder_stack.append('')
        elif tag == 'span':
            if 'ptree-name' in cls:
                self.span_flags.append('name'); self.buf = []
            elif 'ptree-title' in cls:
                self.span_flags.append('title'); self.buf = []
            else:
                self.span_flags.append(None)
        elif tag == 'ul' and 'ptree-list' in cls:
            entry = {'path': '/'.join(n for n in self.folder_stack if n), 'articles': []}
            self.results.append(entry)
            self.ul_stack.append(entry)

    def handle_endtag(self, tag):
        if tag == 'details':
            if self.folder_stack:
                self.folder_stack.pop()
        elif tag == 'span':
            flag = self.span_flags.pop() if self.span_flags else None
            if flag == 'name':
                if self.folder_stack:
                    self.folder_stack[-1] = ''.join(self.buf).strip()
                self.buf = []
            elif flag == 'title':
                if self.ul_stack:
                    self.ul_stack[-1]['articles'].append(''.join(self.buf).strip())
                self.buf = []
        elif tag == 'ul':
            if self.ul_stack:
                self.ul_stack.pop()

    def handle_data(self, data):
        # 收集被追踪 span 内的文本；DRAFT 徽章的嵌套 span 文本也算进标题（与浏览器 textContent 一致）
        if any(f is not None for f in self.span_flags):
            self.buf.append(data)


html = open(sys.argv[1], encoding='utf-8').read()
i = html.find('ptree-root')
html = html[html.rfind('<ul', 0, i):]   # 从根 <ul> 的开标签开始，别切掉它
p = TreeParser()
p.feed(html)
json.dump(p.results, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps([{'path': r['path'] or '<ROOT>', 'n': len(r['articles'])} for r in p.results], ensure_ascii=False, indent=1))
