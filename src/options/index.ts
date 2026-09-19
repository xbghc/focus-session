import "./form.ts";
import { setupSectionNav } from "./nav.ts";

/*
 * 扩展设置页的入口。表单本身在 form.ts，App 的设置页也用它；这里只多一样 App 不要的东西：
 * 左侧的分区目录。App 把每个分区折成一行（见 app/settingsLayout.ts），那份列表自己就是目录。
 */
setupSectionNav();
