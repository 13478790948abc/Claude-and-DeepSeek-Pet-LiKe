# tools/（可选）

这些脚本是作者生成 `assets/spritesheet.png` 时用的 Python 脚本（Pillow + 本地抠图/参考素材），
路径是作者机器上的绝对路径，保留在这里仅供参考/复现，直接运行前需要改成你自己的路径。

- `clean_cutouts.py`：DeepSeek 抠图清理
- `fix_ds_mouth.py`：DeepSeek 嘴部重绘
- `clean_new_claude.py`：Claude 抠图清理
- `make_cutout_sprite.py`：合成 56 帧 spritesheet（idle / snuggle / done）
- `make_photos.py`：生成宣传合照
