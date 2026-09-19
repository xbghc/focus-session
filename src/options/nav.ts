/**
 * 分区目录：十几个分区排成一长条，没有目录就只能靠滚。
 *
 * 目录从页面上现有的 fieldset 现生成，不在 HTML 里再抄一遍分区名——加分区时只改一处。
 * 名字取 `data-nav`，没有就取 legend；`data-nav-group` 标在每组的第一个分区上。
 * 分组不是装饰：三组分别归三处保存按钮管，目录上写出来，省得猜「保存」管到哪儿。
 *
 * 目录只在宽屏上显示（断点在 options.html），窄了就是原来那一条。
 */
/** 分区的名字：legend 里直接写着的字。旁边坐着的「i」按钮不算——App 的分区列表也靠它认分区。 */
export function sectionName(fieldset: HTMLFieldSetElement): string {
  const legend = fieldset.querySelector("legend");
  return [...(legend?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join("").trim();
}

export function setupSectionNav(): void {
  const sections = [...document.querySelectorAll<HTMLFieldSetElement>("body > fieldset[id]")];
  if (sections.length === 0) return;

  const nav = document.createElement("nav");
  nav.className = "section-nav";
  nav.setAttribute("aria-label", "设置分区");
  const links = new Map<HTMLFieldSetElement, HTMLAnchorElement>();
  for (const section of sections) {
    const group = section.dataset.navGroup;
    if (group) {
      const heading = document.createElement("p");
      heading.textContent = group;
      nav.append(heading);
    }
    const link = document.createElement("a");
    link.href = `#${section.id}`;
    link.textContent = section.dataset.nav ?? (sectionName(section) || section.id);
    nav.append(link);
    links.set(section, link);
  }
  document.body.prepend(nav);
  document.body.classList.add("has-nav");

  const activate = (active: HTMLFieldSetElement | undefined): void => {
    for (const [section, link] of links) {
      if (section === active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  };

  /*
   * 点了目录之后先认点的那一项，滚动停下之前不按位置重算：页尾那两个分区太短，滚不到视口顶上，
   * 按位置算的话点「数据」亮起来的会是「诊断日志」。原地不动的点击等不来 scrollend，所以再兜一个超时。
   */
  let pinned: ReturnType<typeof setTimeout> | null = null;
  const unpin = (): void => {
    if (pinned !== null) clearTimeout(pinned);
    pinned = null;
  };
  nav.addEventListener("click", (e) => {
    const link = (e.target as Element).closest("a");
    const section = [...links].find(([, a]) => a === link)?.[0];
    if (!section) return;
    unpin();
    pinned = setTimeout(unpin, 1500);
    activate(section);
  });
  // 不当场放开：同一帧里 scroll 排下的那次重算还没跑，当场放开它就把刚点的那一项改掉了
  window.addEventListener("scrollend", () => {
    if (pinned === null) return;
    clearTimeout(pinned);
    pinned = setTimeout(unpin, 100);
  });

  /** 当前分区：顶边已经滚过视口上沿那条线的最后一个；滚到底时就是最后一个，它再短也轮得到。 */
  const mark = (): void => {
    if (pinned !== null) return;
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    let active = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 96) active = section;
    }
    activate(atBottom ? sections[sections.length - 1] : active);
  };

  let queued = false;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      mark();
    });
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  mark();
}
