# Task 1 Report

- status: DONE_WITH_CONCERNS
- modified_files:
  - `requirements.txt`
  - `app/services/makerworld_captcha_vision.py`
  - `tests/test_makerworld_captcha_vision.py`
  - `.superpowers/sdd/2026-08-06-makerworld-automatic-verification/task-1-report.md`
- red_test_command: `./.venv/bin/python -m pytest tests/test_makerworld_captcha_vision.py -q`
- red_expected_failure: collection fails with `ModuleNotFoundError: No module named 'app.services.makerworld_captcha_vision'`
- green_test_command: `./.venv/bin/python -m pytest tests/test_makerworld_captcha_vision.py -q`
- green_summary: `2 passed in 0.33s`
- commit: `feat: 添加验证码图标识别器`
- residual_risk:
  - `solve_slider_challenge()` 目前只提供受限输入校验与占位返回，后续任务需要补完真实滑块定位逻辑。
  - 图标识别仅通过合成 OpenCV fixture 验证，尚未覆盖真实 MakerWorld 验证码素材的噪声与抗锯齿差异。

## Fix Round 1

- status: DONE_WITH_CONCERNS
- focused_red_test_command: `./.venv/bin/python -m pytest tests/test_makerworld_captcha_vision.py -q`
- focused_red_summary:
  - `7 failed, 6 passed, 5 subtests passed in 0.72s`
  - 失败点覆盖：小/大尺寸三角形匹配、`solve_request()` 的严格字段拒绝、base64 请求入口回归。
- focused_green_test_command: `./.venv/bin/python -m pytest tests/test_makerworld_captcha_vision.py -q`
- focused_green_summary: `8 passed, 10 subtests passed in 0.29s`
- commit: `40a11e6` `fix: 收紧验证码视觉请求契约`
- fix_round_changes:
  - `solve_request()` 改为按 `mode` 的允许字段集合拒绝未知顶层字段，大小写变体与敏感字段不再被静默接受。
  - `_normalize_mask()` 统一小图放大与大图缩小路径，`symbol(size=72)` 等 fixture 坐标改为按 `size` 比例生成。
  - 新增 `solve_request()` 与 `solve_slider_challenge()` 的公开行为测试，覆盖 base64、未知字段、无效图像、无效 geometry 与滑块占位失败返回。
