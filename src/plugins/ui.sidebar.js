// 检查器标签页：属性 / 数据 / 日志

export default {
  id: 'xiaomo.ui.sidebar',
  name: '检查器标签',
  version: '1.0.0',
  kind: 'ui',
  desc: '在属性、数据、日志三页之间切换，指示条平滑滑动',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '布局'],
  setup(ctx) {
    const nav = document.getElementById('sideTabs');
    if (!nav) return;
    const ink = nav.querySelector('#sideInk');
    const btns = [...nav.querySelectorAll('button')];
    const panes = [...document.querySelectorAll('#sidebar .pane')];

    // 指示条只走 transform（§2-C1 C4，配合 §2-A8 删掉 width 过渡）：
    // 三个标签都是 2 汉字 + padding:0 12px，offsetWidth 实际相等，
    // 于是宽度只在「真的变了」的校准路径上写一次，点击路径永远只写 transform。
    let inkW = 0;

    const moveInk = () => {
      const b = nav.querySelector('button.active') || btns[0];
      if (!ink || !b) return;
      const w = b.offsetWidth;
      if (w && w !== inkW) { inkW = w; ink.style.width = w + 'px'; }
      ink.style.transform = `translateX(${b.offsetLeft}px)`;
    };

    const activate = (b) => {
      btns.forEach(x => x.classList.toggle('active', x === b));
      const id = 'pane-' + b.dataset.pane;
      panes.forEach(p => p.classList.toggle('active', p.id === id));
      moveInk();
    };

    btns.forEach(b => b.addEventListener('click', () => activate(b)));
    window.addEventListener('resize', moveInk);
    activate(btns[0]);
    requestAnimationFrame(moveInk);
    setTimeout(moveInk, 120);   // 字体加载完成后再校准一次
  },
};
