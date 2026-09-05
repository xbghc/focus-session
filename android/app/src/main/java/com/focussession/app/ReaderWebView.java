package com.focussession.app;

import android.content.Context;
import android.graphics.Rect;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.WebView;

/**
 * 去掉长按选中文本时系统弹出的「复制 / 分享 / 全选 / 搜索」工具条。
 *
 * 阅读器里选中一段英文，网页那边 600ms 后就会弹翻译浮层；系统工具条正好压在
 * 同一个位置，两个东西叠在一起谁都看不清。选区本身和两个把手照旧——
 * 只是把菜单清空，工具条没有条目就不会画出来。
 */
public class ReaderWebView extends WebView {

    public ReaderWebView(Context context) {
        super(context);
    }

    public ReaderWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback) {
        return super.startActionMode(wrap(callback));
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        return super.startActionMode(wrap(callback), type);
    }

    private static ActionMode.Callback wrap(final ActionMode.Callback inner) {
        if (inner == null) return null;
        return new ActionMode.Callback2() {
            @Override
            public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                boolean ok = inner.onCreateActionMode(mode, menu);
                menu.clear();
                return ok;
            }

            @Override
            public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                inner.onPrepareActionMode(mode, menu);
                menu.clear();
                return true;
            }

            @Override
            public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
                return inner.onActionItemClicked(mode, item);
            }

            @Override
            public void onDestroyActionMode(ActionMode mode) {
                inner.onDestroyActionMode(mode);
            }

            @Override
            public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
                if (inner instanceof ActionMode.Callback2) {
                    ((ActionMode.Callback2) inner).onGetContentRect(mode, view, outRect);
                } else {
                    super.onGetContentRect(mode, view, outRect);
                }
            }
        };
    }
}
