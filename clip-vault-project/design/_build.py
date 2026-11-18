#!/usr/bin/env python3
"""Generates the three static mockups (a/b/c index.html) from _moments.json. Mockups only; not part of the site."""
import json, os
D = os.path.dirname(os.path.abspath(__file__))
M = json.load(open(D + '/_moments.json'))
STREAMS = [
    dict(n=1, title='Playing every GTA until I beat it', chan='Kai Cenat Live', date='18 Nov', moments=14, clips=28, mb='412 MB'),
    dict(n=2, title='GTA V marathon stream', chan='GamerFleet', date='16 Nov', moments=None, clips=15, mb='388 MB'),
    dict(n=3, title='This is not a game', chan='CarryisLive', date='14 Nov', moments=None, clips=3, mb='61 MB'),
]
STITLE = 'Playing every GTA until I beat it: Grand Theft Auto 5'

SPRITE = '''<svg class="sprite" width="0" height="0" aria-hidden="true"><defs>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></symbol>
<symbol id="i-dots" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="i-star" viewBox="0 0 24 24"><path d="m12 3 2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.9 6.4 20l1.3-6.2L3 9.5l6.3-.7z" fill="currentColor"/></symbol>
<symbol id="i-back" viewBox="0 0 24 24"><path d="m14.5 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-lib" viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></symbol>
<symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 7h16M7 12h10M10 17h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="i-post" viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="1.9"/></symbol>
<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
<symbol id="i-dl" viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</defs></svg>'''

def ico(n, cls=''):
    return f'<svg class="ico {cls}" aria-hidden="true"><use href="#i-{n}"/></svg>'

def filt(m):
    c = ['f-all']
    if m['tier'] == 'A': c.append('f-best')
    c.append('f-react' if m['kind'] == 'reaction' else 'f-game')
    c.append('t-' + m['tier'])
    return ' '.join(c)

def react_html(m):
    r = m['reaction']
    if r not in ('strong', 'mild', 'none'): return ''
    n = {'strong': 3, 'mild': 2, 'none': 0}[r]
    bars = ''.join(f'<i{" class=on" if i < n else ""}></i>' for i in range(3))
    return f'<p class="react r-{r}"><span class="meter" aria-hidden="true">{bars}</span>Reaction: {r}</p>'

def menu_html(label='More actions'):
    return (f'<details class="menu"><summary aria-label="{label}">{ico("dots")}</summary><div class="menu-list">'
            f'<a href="#stream">Play</a><a href="#stream">Download</a><a href="#stream">Post kit</a><a href="#stream">Mark as posted</a><a href="#stream">Edit details</a></div></details>')

def vers_html(m, suffix=''):
    n = f"{m['n']}{suffix}"
    return (f'<div class="vers" role="radiogroup" aria-label="Version">'
            f'<input class="sr vw" type="radio" name="v{n}" id="w{n}" checked><label class="lw" for="w{n}">With streamer</label>'
            f'<input class="sr vc" type="radio" name="v{n}" id="c{n}"><label class="lc" for="c{n}">Clean</label></div>')

def imgs(m, cls='poster'):
    n = m['n']
    return (f'<span class="{cls}"><img class="img-c" src="img/c{n}.jpg" alt="" width="360" height="640" loading="lazy">'
            f'<img class="img-w" src="img/p{n}.jpg" alt="" width="360" height="640" loading="lazy"></span>')

CATS = [('best', 'Best', 3), ('react', 'Streamer reactions', 8), ('game', 'Game moments', 6), ('all', 'All', 14)]

def head(title, extra=''):
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; font-src 'self'; style-src 'self'">
<meta name="color-scheme" content="dark light"><title>{title}</title><link rel="stylesheet" href="style.css"></head>
<body>
<input class="sr" type="checkbox" id="theme" aria-label="Light theme">
{SPRITE}
'''

def header(kind):
    menu = ('<details class="menu hm"><summary aria-label="Menu">' + ico('dots') + '</summary><div class="menu-list">'
            '<a href="#home">' + ico('filter') + 'Filter and sort</a>'
            '<label for="theme">' + ico('sun') + 'Light / dark theme</label>'
            '<a href="#home">' + ico('lock') + 'Lock library</a></div></details>')
    search = ('<details class="menu hs"><summary aria-label="Search">' + ico('search') + '</summary>'
              '<div class="searchbox"><input type="search" placeholder="Search moments, streams" aria-label="Search"></div></details>')
    return (f'<header class="top"><a class="brand" href="#home" aria-label="FRAGBAG library home"><img src="img/logo.png" width="40" height="40" alt="FRAGBAG"><span class="brand-t">FRAGBAG</span></a>'
            f'<div class="tools">{search}<a class="postmode" href="#stream">{ico("post")}<span>Post mode</span></a>{menu}</div></header>\n')


# ---------------------------------------------------------------- A: editorial
def card_a(m):
    top = m['tier'] == 'A'
    rank = (f'<p class="rank">{ico("star")}<span>{"Top pick" if m["rank"] == 1 else "No. " + str(m["rank"])}</span></p>' if top else '')
    return (f'<article class="m {filt(m)}{" lead" if m["rank"]==1 else ""}">'
            f'<div class="pw">{imgs(m)}<span class="dur">{m["dur"]} s</span></div>'
            f'<div class="body"><div class="row1">{rank}{menu_html()}</div>'
            f'<h3>{m["title"]}</h3><p class="why">{m["why"]}</p>{react_html(m)}{vers_html(m)}</div></article>')

def build_a():
    h = head('FRAGBAG Library: Editorial')
    h += header('a')
    h += '<main>\n<section id="home" class="screen"><div class="wrap">'
    h += '<p class="kicker">Library</p><h1 class="display">Streams</h1><p class="sum">3 streams · 32 moments · ready to post</p><ol class="stacks">'
    for i, s in enumerate(STREAMS):
        cnt = f'{s["moments"]} moments' if s['moments'] else f'{s["clips"]} clips'
        sub = f'{s["moments"]} moments · {s["clips"]} clips' if s['moments'] else f'{s["clips"]} clips'
        h += (f'<li><a class="stack" href="#stream"><span class="folder"><span class="tab">{cnt}</span><span class="sheet s2"></span><span class="sheet s1"></span>'
              f'<img src="img/t{s["n"]}.jpg" width="640" height="360" alt=""></span>'
              f'<span class="no" aria-hidden="true">0{s["n"]}</span><span class="st"><strong>{s["title"]}</strong>'
              f'<span class="meta">{s["chan"]} · {s["date"]} · {s["mb"]}</span></span></a></li>')
    h += '</ol></div></section>\n'
    h += '<section id="stream" class="screen"><div class="wrap">'
    for k, l, c in CATS:
        h += f'<input class="sr" type="radio" name="cat" id="cat-{k}"{" checked" if k=="best" else ""}>'
    h += f'<a class="back" href="#home">{ico("back")}Library</a><p class="kicker">18 Nov 2026 · Kai Cenat Live</p><h1 class="display sm">{STITLE}</h1>'
    h += '<p class="sum">14 moments · 28 clips</p><nav class="cats" aria-label="Categories">'
    for k, l, c in CATS:
        h += f'<label for="cat-{k}" class="cat-{k}">{l}<sup>{c}</sup></label>'
    h += '</nav><div class="list">'
    for m in M: h += card_a(m)
    h += '</div></div></section>\n</main>\n</body></html>\n'
    open(D + '/a/index.html', 'w').write(h)


# ---------------------------------------------------------------- B: glass
def card_b(m):
    top = m['tier'] == 'A'
    star = f'<span class="rk">{ico("star")}{m["rank"]}</span>' if top else ''
    return (f'<article class="m {filt(m)}{" lead" if m["rank"]==1 else ""}">'
            f'<div class="pw">{imgs(m)}{star}<span class="dur">{m["dur"]} s</span></div>'
            f'<div class="body"><div class="row1">{("<p class=lab>Top pick</p>" if m["rank"]==1 else ("<p class=lab>Best clip</p>" if top else "<span></span>"))}{menu_html()}</div>'
            f'<h3>{m["title"]}</h3><p class="why">{m["why"]}</p>{react_html(m)}{vers_html(m)}</div></article>')

def build_b():
    h = head('FRAGBAG Library: Glass')
    h += header('b')
    h += '<main>\n<section id="home" class="screen"><img class="bgimg" src="img/t1.jpg" alt="" width="640" height="360"><div class="wrap">'
    h += '<h1 class="large">Library</h1><p class="sum">3 streams · 32 moments</p><ul class="folders">'
    for s in STREAMS:
        cnt = f'{s["moments"]} moments' if s['moments'] else f'{s["clips"]} clips'
        h += (f'<li><a class="fold" href="#stream"><span class="fback"></span><img class="fthumb" src="img/t{s["n"]}.jpg" width="640" height="360" alt="">'
              f'<span class="ffront"><span class="ft"><strong>{s["title"]}</strong><span class="meta">{s["chan"]} · {s["date"]}</span></span>'
              f'<span class="pill">{cnt}</span></span></a></li>')
    h += '</ul></div>'
    h += f'<nav class="dock" aria-label="Library"><a class="on" href="#home">{ico("lib")}<span>Library</span></a><a href="#stream">{ico("star")}<span>Best picks</span></a><a href="#stream">{ico("post")}<span>Post mode</span></a></nav></section>\n'
    h += '<section id="stream" class="screen"><img class="bgimg" src="img/t1.jpg" alt="" width="640" height="360"><div class="wrap">'
    for k, l, c in CATS:
        h += f'<input class="sr" type="radio" name="cat" id="cat-{k}"{" checked" if k=="best" else ""}>'
    h += (f'<div class="hero"><img src="img/t1.jpg" alt="" width="640" height="360"><a class="chip" href="#home">{ico("back")}Library</a>'
          f'<div class="ht"><p class="sum">18 Nov 2026 · Kai Cenat Live</p><h1>{STITLE}</h1></div></div>')
    h += '<div class="list">'
    for m in M: h += card_b(m)
    h += '</div></div><nav class="seg" aria-label="Categories"><i class="knob"></i>'
    for k, l, c in CATS:
        h += f'<label for="cat-{k}" class="cat-{k}"><span>{l}</span><sup>{c}</sup></label>'
    h += '</nav></section>\n</main>\n</body></html>\n'
    open(D + '/b/index.html', 'w').write(h)


# ---------------------------------------------------------------- C: feed
def card_c(m, suffix=''):
    top = m['tier'] == 'A'
    star = f'<span class="rk">{ico("star")}{m["rank"]}</span>' if top else ''
    return (f'<article class="m {filt(m)}">'
            f'<div class="pw">{imgs(m)}{star}<span class="dur">{m["dur"]} s</span><a class="play" href="#stream" aria-label="Play {m["title"]}">{ico("play")}</a>'
            f'{menu_html()}</div>'
            f'<div class="body"><h3>{m["title"]}</h3><p class="why">{m["why"]}</p>{react_html(m)}{vers_html(m, suffix)}</div></article>')

def build_c():
    h = head('FRAGBAG Library: Feed')
    h += header('c')
    h += '<main>\n<section id="home" class="screen"><div class="wrap">'
    h += '<h1 class="h">Streams</h1>'
    s = STREAMS[0]
    h += (f'<a class="deck big" href="#stream"><span class="card"><img src="img/t1.jpg" width="640" height="360" alt="">'
          f'<span class="fan" aria-hidden="true"><img src="img/p1.jpg" alt="" width="360" height="640"><img src="img/p2.jpg" alt="" width="360" height="640"><img src="img/p3.jpg" alt="" width="360" height="640"></span>'
          f'<span class="cap"><span class="badge">14 moments · 3 best</span><strong>{s["title"]}</strong><span class="meta">{s["chan"]} · {s["date"]}</span></span></span></a>')
    h += '<h2 class="rowh">Earlier</h2><ul class="track decks">'
    for s in STREAMS[1:]:
        cnt = f'{s["clips"]} clips'
        h += (f'<li><a class="deck" href="#stream"><span class="card"><img src="img/t{s["n"]}.jpg" width="640" height="360" alt="">'
              f'<span class="cap"><span class="badge">{cnt}</span><strong>{s["title"]}</strong><span class="meta">{s["chan"]} · {s["date"]}</span></span></span></a></li>')
    h += '</ul><h2 class="rowh">Top picks <sup>all streams</sup></h2><ul class="track picks">'
    for m in M[:3]:
        h += (f'<li><a class="pick" href="#stream"><span class="pp"><img src="img/p{m["n"]}.jpg" width="360" height="640" alt=""><span class="rk">{ico("star")}{m["rank"]}</span><span class="dur">{m["dur"]} s</span></span>'
              f'<strong>{m["title"]}</strong></a></li>')
    h += '</ul></div></section>\n'
    h += '<section id="stream" class="screen">'
    for k, l, c in CATS:
        h += f'<input class="sr" type="radio" name="cat" id="cat-{k}"{" checked" if k=="all" else ""}>'
    b = M[0]
    h += (f'<div class="best m {filt(b)}">{imgs(b, "hposter")}<div class="scrim"></div><a class="back" href="#home">{ico("back")}Library</a>'
          f'<div class="hb"><p class="lab">{ico("star")}Best clip in this stream</p><h2>{b["title"]}</h2><p class="why">{b["why"]}</p>'
          f'<div class="meta2">{react_html(b)}<span class="durl">{b["dur"]} s</span></div>'
          f'<div class="act"><a class="go" href="#stream">{ico("play")}Play</a>{vers_html(b, "h")}{menu_html()}</div></div></div>')
    h += '<div class="chips" role="group" aria-label="Categories">'
    for k, l, c in [CATS[3]] + CATS[:3]:
        h += f'<label for="cat-{k}" class="cat-{k}">{l}<sup>{c}</sup></label>'
    h += '</div><div class="rows">'
    rows = [('best', 'Best', [m for m in M if m['tier'] == 'A']),
            ('react', 'Streamer reactions', [m for m in M if m['kind'] == 'reaction']),
            ('game', 'Game moments', [m for m in M if m['kind'] == 'game'])]
    for k, l, ms in rows:
        h += f'<section class="row r-{k}"><h2 class="rowh">{l}<sup>{len(ms)}</sup></h2><div class="track">'
        for m in ms: h += card_c(m, 'r' + k[0])
        h += '</div></section>'
    h += '</div></section>\n</main>\n</body></html>\n'
    open(D + '/c/index.html', 'w').write(h)

if __name__ == '__main__':
    build_a(); build_b(); build_c()
