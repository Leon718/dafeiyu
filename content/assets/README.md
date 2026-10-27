把你自己生成的 .webm 动画放这里。

规则很简单：**文件名和 assets/third-party/webm/ 里的同名，就会自动接管。**
优先级在 engine/paths.js 的 assetIndex()：先扫第三方，再扫这里，后写的覆盖前面的。

怎么生成自己的动画（AI 视频 → 绿幕 → 透明 webm 的完整管线）：
https://github.com/PC2005-cloud/dsh-pet/blob/main/MAKE-YOUR-OWN-PET.md

这个目录下的文件不受 content/LICENSE 约束 ——
这里放的是你自己的画，你的东西你自己定许可。
