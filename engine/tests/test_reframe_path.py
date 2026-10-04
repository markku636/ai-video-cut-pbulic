"""自動重構圖的路徑規劃（reframe/path.py）：長寬比、裁切尺寸、追焦手感、切換、邊界。

`follow_axis` 是「成品好不好看」的全部，所以測得最密：盲區真的不動、起步有加速度、
到位會停、跳太遠用切的、永遠不出界。這些在沒有影片的情況下就能驗完 —— 那正是把它寫成純函式的理由。
"""

from __future__ import annotations

import pytest

from aivc.reframe.path import (
    AxisParams,
    Box,
    CropRect,
    ReframeError,
    ReframeOptions,
    center_bounds,
    centers_from_boxes,
    crop_size,
    desired_center,
    detect_cuts,
    fill_gaps,
    interpolate_centers,
    follow_axis,
    parse_aspect,
    pick_subject,
    plan_path,
    segments,
    static_path,
)

HD = (1920, 1080)


class TestParseAspect:
    def test_預設值與分隔符(self) -> None:
        assert parse_aspect("9:16") == (9, 16)
        assert parse_aspect("9x16") == (9, 16)
        assert parse_aspect("9/16") == (9, 16)
        assert parse_aspect(" 16:9 ") == (16, 9)

    def test_小數與比值等價(self) -> None:
        # 0.5625 == 9/16；兩種寫法必須得到同一個答案，否則同一支影片用兩種寫法會有兩種輸出尺寸
        assert parse_aspect("0.5625") == parse_aspect("9:16")

    def test_不合法(self) -> None:
        for bad in ["", "abc", "9:0", "-1:2", "0"]:
            with pytest.raises(ReframeError):
                parse_aspect(bad)


class TestCropSize:
    def test_長寬比精確而不是最大再取整(self) -> None:
        # 1920×1080 取 9:16 的理論最大是 607.5×1080；取整成 608×1080 比例會跑掉
        w, h = crop_size(1920, 1080, (9, 16))
        assert (w, h) == (594, 1056)
        assert w * 16 == h * 9  # 精確
        assert w % 2 == 0 and h % 2 == 0  # yuv420 的硬性要求

    def test_塞得進來源(self) -> None:
        for aspect in [(9, 16), (1, 1), (4, 5), (4, 3), (239, 100)]:
            w, h = crop_size(1920, 1080, aspect)
            assert w <= 1920 and h <= 1080, aspect
            assert w % 2 == 0 and h % 2 == 0, aspect

    def test_目標比來源寬時吃滿寬度(self) -> None:
        w, h = crop_size(1920, 1080, (16, 9))
        assert (w, h) == (1920, 1080)

    def test_zoom_推近就變小(self) -> None:
        a = crop_size(1920, 1080, (9, 16), 1.0)
        b = crop_size(1920, 1080, (9, 16), 2.0)
        assert b[0] < a[0] and b[1] < a[1]
        assert b[0] * 16 == b[1] * 9

    def test_zoom_小於一時夾回來源(self) -> None:
        # 拉遠拉到超出來源沒有意義（外面沒有像素），要夾回最大可用
        assert crop_size(1920, 1080, (9, 16), 0.2) == crop_size(1920, 1080, (9, 16), 1.0)

    def test_來源太小(self) -> None:
        with pytest.raises(ReframeError):
            crop_size(1, 1, (9, 16))


class TestCenterBounds:
    def test_一般情況(self) -> None:
        assert center_bounds(1920, 594) == (297.0, 1623.0)

    def test_框跟來源一樣大時這條軸不能動(self) -> None:
        lo, hi = center_bounds(1080, 1080)
        assert lo == hi == 540.0


class TestDesiredCenter:
    def test_沒有框回_none(self) -> None:
        assert desired_center([], 594, 1056) is None

    def test_單一框取中心(self) -> None:
        assert desired_center([Box(100, 200, 50, 80)], 594, 1056) == (125.0, 240.0)

    def test_塞得下就框住全部(self) -> None:
        c = desired_center([Box(0, 0, 100, 100), Box(300, 0, 100, 100)], 594, 1056)
        assert c == (200.0, 50.0)  # 聯集 0..400 的中心

    def test_塞不下就只跟分數最高的(self) -> None:
        # 兩個人隔了 1500 px，裁切框只有 594 寬：取聯集中心會讓兩個人都半個在畫面外
        far = [Box(0, 400, 100, 200, score=0.3), Box(1500, 400, 100, 200, score=0.9)]
        assert desired_center(far, 594, 1056) == (1550.0, 500.0)

    def test_分數相同時取比較大的框(self) -> None:
        far = [Box(0, 0, 100, 100, score=0.5), Box(1500, 0, 300, 300, score=0.5)]
        cx, _ = desired_center(far, 594, 1056)  # type: ignore[misc]
        assert cx == 1650.0

    def test_bias_把主體推離中央(self) -> None:
        # bias_y 正值 → 裁切框往下挪 → 主體在成品裡偏上（頭頂留白）
        c = desired_center([Box(100, 200, 50, 80)], 600, 1000, bias_y=0.1)
        assert c == (125.0, 240.0 + 100.0)


class TestSubjectStickiness:
    """畫面裡兩個主體時，鏡頭該黏住原來那個，不該跟著偵測分數的抖動換人。"""

    def test_沒有_prev_時跟分數最高的(self) -> None:
        bs = [Box(0, 0, 100, 100, score=0.4), Box(1500, 0, 100, 100, score=0.9)]
        assert pick_subject(bs, None).cx == 1550.0

    def test_有_prev_時黏住近的那個(self) -> None:
        # 右邊分數略高（0.9 vs 0.8，在 0.75 倍的容忍內），但鏡頭本來在左邊 → 不換人
        bs = [Box(0, 0, 100, 100, score=0.8), Box(1500, 0, 100, 100, score=0.9)]
        assert pick_subject(bs, (50.0, 50.0)).cx == 50.0

    def test_分數差夠大才換人(self) -> None:
        # 0.2 < 0.9 × 0.75：新主體明顯更像，這時該換
        bs = [Box(0, 0, 100, 100, score=0.2), Box(1500, 0, 100, 100, score=0.9)]
        assert pick_subject(bs, (50.0, 50.0)).cx == 1550.0

    def test_關掉黏著(self) -> None:
        bs = [Box(0, 0, 100, 100, score=0.8), Box(1500, 0, 100, 100, score=0.9)]
        assert pick_subject(bs, (50.0, 50.0), stick_ratio=0).cx == 1550.0

    def test_分數互換不會讓鏡頭來回切(self) -> None:
        # 這是實測出來的問題：一段七秒的雙手畫面，兩隻手的分數每次偵測互換一次 → 切六次
        frames = []
        for i in range(20):
            a, b = (0.9, 0.8) if i % 2 else (0.8, 0.9)
            frames.append([Box(100, 400, 120, 200, score=a), Box(1600, 400, 120, 200, score=b)])
        p = plan_path(frames, HD, 30, ReframeOptions())
        assert p.cuts == [0], f"黏著失效，切了 {p.cuts}"
        assert p.static

    def test_跟丟幾幀不會換人(self) -> None:
        # 沒有偵測的幀不更新 prev，所以主體回來時仍然黏著原來那個
        one = [Box(100, 400, 120, 200, score=0.8), Box(1600, 400, 120, 200, score=0.9)]
        cs = centers_from_boxes([one, [], [], one], 396, 704, ReframeOptions())
        assert cs[0] == cs[3]


class TestFillGaps:
    def test_沿用上一個而不是回中央(self) -> None:
        got, miss = fill_gaps([(10.0, 10.0), None, None, (50.0, 50.0)], (0.0, 0.0))
        assert got == [(10.0, 10.0), (10.0, 10.0), (10.0, 10.0), (50.0, 50.0)]
        assert miss == 2

    def test_開頭就沒有時往後借(self) -> None:
        got, miss = fill_gaps([None, None, (7.0, 8.0)], (0.0, 0.0))
        assert got == [(7.0, 8.0), (7.0, 8.0), (7.0, 8.0)]
        assert miss == 2

    def test_整段都沒有就用_fallback(self) -> None:
        got, miss = fill_gaps([None, None], (960.0, 540.0))
        assert got == [(960.0, 540.0)] * 2
        assert miss == 2


class TestInterpolateCenters:
    def test_內部空洞線性補起來(self) -> None:
        got = interpolate_centers([(0.0, 0.0), None, None, (30.0, 60.0)], (1e9, 1e9))
        assert got == [(0.0, 0.0), (10.0, 20.0), (20.0, 40.0), (30.0, 60.0)]

    def test_跳太遠的空洞不補(self) -> None:
        # 兩個取樣點之間有鏡頭切點：內插會把「一幀就位」攤成六幀甩鏡，而且攤平後連切點都認不出來
        got = interpolate_centers([(0.0, 0.0), None, (1800.0, 0.0)], (500.0, 500.0))
        assert got[1] is None

    def test_頭尾不碰(self) -> None:
        got = interpolate_centers([None, (10.0, 10.0), (20.0, 20.0), None], (1e9, 1e9))
        assert got[0] is None and got[3] is None

    def test_少於兩個已知點就原樣回(self) -> None:
        assert interpolate_centers([None, None], (1e9, 1e9)) == [None, None]
        assert interpolate_centers([None, (1.0, 1.0)], (1e9, 1e9)) == [None, (1.0, 1.0)]

    def test_抽樣後仍然抓得到切點(self) -> None:
        # 每 6 幀取樣一次，第 6 個取樣點換了人：內插不補 → fill_gaps 沿用 → 跳躍完整保留 → detect_cuts 抓得到
        raw: list[tuple[float, float] | None] = [None] * 13
        raw[0] = raw[6] = (200.0, 500.0)
        raw[12] = (1700.0, 500.0)
        filled, _ = fill_gaps(interpolate_centers(raw, (600.0, 600.0)), (960.0, 540.0))
        assert detect_cuts(filled, 1920, 1080, 0.35) == {12}


class TestDetectCuts:
    def test_跳太遠才算切(self) -> None:
        cs = [(100.0, 500.0), (140.0, 500.0), (1500.0, 500.0), (1510.0, 500.0)]
        assert detect_cuts(cs, 1920, 1080, 0.35) == {2}

    def test_門檻為零等於關掉(self) -> None:
        assert detect_cuts([(0.0, 0.0), (1900.0, 0.0)], 1920, 1080, 0.0) == set()


def _params(**kw: float) -> AxisParams:
    base = dict(lo=0.0, hi=1000.0, deadzone=50.0, settle=1.0, max_speed=20.0, max_accel=4.0, gain=0.2)
    base.update(kw)
    return AxisParams(**base)  # type: ignore[arg-type]


class TestFollowAxis:
    def test_第一幀直接就位(self) -> None:
        assert follow_axis([300.0], _params())[0] == 300.0

    def test_盲區內完全不動(self) -> None:
        # 主體在中央一帶晃 ±40（盲區 50）：鏡頭一格都不能動，這是「不像機器裁的」最大來源
        xs = follow_axis([500.0, 540.0, 460.0, 535.0, 500.0], _params())
        assert xs == [500.0] * 5

    def test_超出盲區才起步(self) -> None:
        xs = follow_axis([500.0] + [600.0] * 30, _params())
        assert xs[1] > 500.0
        assert xs[-1] == pytest.approx(600.0, abs=1.0)

    def test_起步受加速度上限(self) -> None:
        # 第一步的位移不可以超過加速度上限；少了這個，平移會是「瞬間到速」的機械感
        xs = follow_axis([500.0] + [900.0] * 5, _params(max_accel=4.0))
        assert xs[1] - xs[0] == pytest.approx(4.0)
        assert xs[2] - xs[1] == pytest.approx(8.0)

    def test_速度不超過上限(self) -> None:
        xs = follow_axis([0.0] + [1000.0] * 200, _params(max_speed=20.0))
        steps = [b - a for a, b in zip(xs, xs[1:])]
        assert max(steps) <= 20.0 + 1e-9

    def test_收尾會慢下來並停住(self) -> None:
        xs = follow_axis([500.0] + [700.0] * 120, _params())
        steps = [b - a for a, b in zip(xs, xs[1:])]
        assert steps[-1] == pytest.approx(0.0, abs=1e-9)  # 真的停了，不是一直微動
        assert xs[-1] == pytest.approx(700.0, abs=1.0)
        # 後半段每一步都不比前半段的最大步大 → 有收尾
        assert max(steps[len(steps) // 2:]) < max(steps[: len(steps) // 2])

    def test_一路平滑沒有回頭(self) -> None:
        xs = follow_axis([500.0] + [800.0] * 80, _params())
        steps = [b - a for a, b in zip(xs, xs[1:])]
        assert all(s >= -1e-9 for s in steps), "追焦過程不該倒車（會看成抖動）"

    def test_切的那一幀直接到位(self) -> None:
        xs = follow_axis([100.0] * 3 + [900.0] * 3, _params(), cuts={3})
        assert xs == [100.0, 100.0, 100.0, 900.0, 900.0, 900.0]

    def test_永遠不出界(self) -> None:
        xs = follow_axis([500.0] + [-9999.0] * 50 + [9999.0] * 50, _params(lo=100.0, hi=800.0))
        assert min(xs) >= 100.0 and max(xs) <= 800.0

    def test_上下界相同時完全不動(self) -> None:
        xs = follow_axis([0.0, 1000.0, 500.0], _params(lo=540.0, hi=540.0))
        assert xs == [540.0] * 3


class TestPlanPath:
    def test_空輸入(self) -> None:
        p = plan_path([], HD, 30, ReframeOptions())
        assert p.rects == [] and p.size == (594, 1056)

    def test_靜態主體給出靜態路徑(self) -> None:
        boxes = [[Box(900, 400, 120, 280)] for _ in range(60)]
        p = plan_path(boxes, HD, 30, ReframeOptions())
        assert p.static
        assert p.missing == 0

    def test_每一格都在來源內而且座標是偶數(self) -> None:
        boxes = [[Box(50 + i * 25, 400, 120, 280)] for i in range(60)]
        p = plan_path(boxes, HD, 30, ReframeOptions())
        for r in p.rects:
            assert r.x % 2 == 0 and r.y % 2 == 0, r
            assert 0 <= r.x and r.x + r.w <= 1920, r
            assert 0 <= r.y and r.y + r.h <= 1080, r

    def test_主體橫移時鏡頭跟上去(self) -> None:
        boxes = [[Box(100 + i * 20, 400, 120, 280)] for i in range(80)]
        p = plan_path(boxes, HD, 30, ReframeOptions())
        assert p.rects[-1].x > p.rects[0].x + 400
        # 逐格位移單調不倒車
        assert all(b.x >= a.x for a, b in zip(p.rects, p.rects[1:]))

    def test_跳到另一個人時用切的(self) -> None:
        left = [[Box(200, 400, 120, 280)] for _ in range(20)]
        right = [[Box(1600, 400, 120, 280)] for _ in range(20)]
        p = plan_path(left + right, HD, 30, ReframeOptions())
        assert 20 in p.cuts
        assert p.rects[20].x - p.rects[19].x > 800  # 一幀到位，不是甩過去

    def test_呼叫端給的鏡頭邊界也會切(self) -> None:
        # 主體其實沒跳（自動偵測不會判成切），但呼叫端知道第 10 幀換鏡頭
        boxes = [[Box(900, 400, 120, 280)] for _ in range(20)]
        p = plan_path(boxes, HD, 30, ReframeOptions(), cuts=[10])
        assert 10 in p.cuts

    def test_沒有偵測的幀沿用上一個(self) -> None:
        boxes: list[list[Box]] = [[Box(200, 400, 120, 280)]] + [[] for _ in range(10)]
        p = plan_path(boxes, HD, 30, ReframeOptions())
        assert p.missing == 10
        assert p.static  # 沿用 → 完全不動；若改成回中央這裡會是一段沒有理由的平移

    def test_整段都沒偵測等於靜態置中(self) -> None:
        p = plan_path([[] for _ in range(10)], HD, 30, ReframeOptions())
        assert p.static and p.missing == 10
        assert p.rects[0].x == pytest.approx((1920 - 594) // 2, abs=2)

    def test_換_fps_不改變手感(self) -> None:
        # 參數是「每秒」，所以**同樣秒數**要走同樣遠 —— 30 fps 與 60 fps 的一秒必須落在同一個位置。
        # （逐格位移當然不同，那不是該比的東西：60 fps 的格數是兩倍。）
        def after_one_second(fps: int) -> int:
            boxes = [[Box(200, 400, 120, 280)]] + [[Box(1600, 400, 120, 280)]] * fps
            p = plan_path(boxes, HD, fps, ReframeOptions(cut_threshold=0))
            return p.rects[-1].x - p.rects[0].x

        a, b = after_one_second(30), after_one_second(60)
        assert a > 200, "一秒該走一段有感的距離，否則這條測試驗不到東西"
        assert abs(a - b) <= 0.15 * a, f"30 fps 走了 {a}、60 fps 走了 {b}，換 fps 就換了手感"

    def test_fps_不合法(self) -> None:
        with pytest.raises(ReframeError):
            plan_path([[]], HD, 0, ReframeOptions())

    def test_參數檢查(self) -> None:
        for bad in [ReframeOptions(zoom=0), ReframeOptions(deadzone=0.9), ReframeOptions(max_speed=0), ReframeOptions(aspect=(0, 1))]:
            with pytest.raises(ReframeError):
                plan_path([[]], HD, 30, bad)


class TestStaticPath:
    def test_置中而且不動(self) -> None:
        p = static_path(HD, 5, ReframeOptions())
        assert p.static and len(p.rects) == 5
        assert p.rects[0] == CropRect(x=664, y=12, w=594, h=1056)

    def test_bias_會偏移(self) -> None:
        p = static_path(HD, 1, ReframeOptions(bias_x=0.1))
        assert p.rects[0].x > static_path(HD, 1, ReframeOptions()).rects[0].x


class TestSegments:
    def test_壓成連續段(self) -> None:
        boxes = [[Box(900, 400, 120, 280)] for _ in range(30)]
        assert len(segments(plan_path(boxes, HD, 30, ReframeOptions()))) == 1

    def test_段落覆蓋每一幀且不重疊(self) -> None:
        boxes = [[Box(100 + i * 30, 400, 120, 280)] for i in range(40)]
        segs = segments(plan_path(boxes, HD, 30, ReframeOptions()))
        assert segs[0][0] == 0 and segs[-1][1] == 40
        assert all(a[1] == b[0] for a, b in zip(segs, segs[1:]))
