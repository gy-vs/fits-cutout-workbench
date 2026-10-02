# FITS cutout workbench

一个完全在本机运行的二维 FITS 图像检查与 WCS 切片工作台：浏览器选择文件，
服务端解析 primary HDU（2880 字节头块 + 二维像素数据），页面提供整图概览、
天球坐标网格、像素/天球读数，以及按「天球中心 + 角尺寸 + 输出像素尺寸」切片、
下载独立 FITS 文件的完整流程。

- **零运行时依赖**：只用 Node.js（≥18）内置模块（`http`、`zlib` 等），前端无构建步骤、无框架。
- **无需数据库或云服务**：上传字节只存在服务端进程内存中，替换文件、关闭页面或闲置 30 分钟即释放。
- **坐标一致性**：像素 → 天球的所有计算（读数、网格、矩形角尺寸、切片重采样、导出 WCS）都在服务端用同一份代码完成；前端不把屏幕像素当成度数。

## 启动

```bash
node server/index.js
# 可指定端口/上传上限： PORT=9000 MAX_UPLOAD_MB=50 node server/index.js
```

打开 <http://127.0.0.1:8080>，首屏即工作区：选择本机 `.fits/.fit/.fts`，
或点击「载入代码生成样本」（Int16 旋转+BLANK 样本、Float32 RA=0+NaN 样本）。

## 测试

```bash
npm test          # node --test：FITS/头解析、WCS 往返、切片、HTTP 端到端共 25 项
```

端到端测试会真实起 HTTP 服务，验证：上传 → PNG 概览 → 像素读数 → 服务端
裁切预览 → 下载 FITS → 用同一解析器重新打开并由新 WCS 重算中心坐标，与页面
读数/矩形中心一致；并验证畸形头、CDELT/PC、不可逆 CD、尺寸乘积溢出、过大
上传、文件替换后的过期 generation 各自返回**可区分的错误码**。

## 支持范围（超出即明确拒绝，不按错误坐标导出）

| 项目 | 支持 |
| --- | --- |
| HDU | primary image（单 HDU） |
| BITPIX | `16`（含 BSCALE/BZERO/BLANK）或 `-32`（NaN 缺失） |
| NAXIS | 2 |
| 投影 | `CTYPE1='RA---TAN'`、`CTYPE2='DEC--TAN'`，单位为度 |
| WCS | `CRPIX1/2`、`CRVAL1/2`、`CD1_1..CD2_2`（CD 矩阵必须可逆） |

以下约定返回 `UNSUPPORTED_WCS` 并指明关键字，绝不静默套用：
`CDELT*`、`PC*_*`、`CROTA*`、非 TAN 的 `CTYPE`、非度单位。

## 关键规则

### 头与像素
- 头卡片严格 80 字节；字符串值按引号解析，`''` 为转义单引号，字符串内的 `/`
  不是注释；`END` 后按 2880 字节对齐。
- 像素按大端序读取。Int16 物理值 = `raw*BSCALE+BZERO`，`BLANK` 为缺失；
  Float32 的非有限值为缺失。缺失值在屏幕采样、预览与导出中语义一致
  （整数导出沿用源 BSCALE/BZERO 与 BLANK，浮点导出写 NaN）。

### WCS
- 采用 WCS Paper II 的纯 TAN（gnomonic）投影，phi0=0；CD 矩阵可含旋转。
- 逆投影到源切平面**背面**的输出像素记为 `offHemisphere` 缺失；落在源像素
  阵列之外的记为 `outside`；预览中缺失为透明（棋盘底）。
- RA 在以 CRVAL 为中心的展开坐标系内处理，切片中心靠近 RA=0° 时正确环绕。

### 切片采样（定义明确、可复现）
1. 输出是中心位于请求天球点、**指北向上**的 TAN 网格；
   `CD1_1 = 角宽/输出宽`、`CD2_2 = 角高/输出高`（度/输出像素）。
2. 对每个**输出像素中心**计算其天球位置，再用**源 WCS 逆投影**回源像素，
   取最近邻源像素（`floor(p-0.5)`）。因此输出分辨率与源网格不同时是清楚的
   「输出中心最近邻」重采样，原值与缺失语义不被插值污染。
3. 输出 `CRPIX` 重定位到切片中心（`(outW+1)/2,(outH+1)/2`），`CRVAL` 为请求
   中心，不沿用原图 CRPIX，避免坐标漂移。
4. 「角宽/角高」按切平面（大圆）板尺度定义；在非零赤纬处经纬度坐标跨度会
   因 `1/cos(dec)` 而更大，这是 TAN 投影的正确行为。

### 过期响应不会覆盖新图
- 服务端为每次会话维护 `generation`：替换文件会递增；携带旧 `gen` 的请求返回
  `409 STALE_GENERATION`。
- 悬停读数、快速连续改参数触发的预览各自携带客户端 `token`；后发请求前会
  abort 旧请求，且回复 token 与当前不符时直接丢弃，不绘制。

## HTTP 接口

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/sample/source?kind=int16\|float32` | 代码生成的小尺寸 FITS 样本 |
| `POST /api/upload` | 原始 FITS 字节 → 会话元数据（含 generation、WCS、概览尺寸） |
| `POST /api/session/:id/release` | 立即释放该会话内存 |
| `POST /api/session/:id/overview?gen=` | 整图降采样 PNG（服务端渲染） |
| `POST /api/session/:id/grid?gen=` | RA/Dec 网格折线（源像素坐标）与标签 |
| `POST /api/session/:id/sample-point?x=&y=&gen=` | 某像素的物理值与 RA/Dec |
| `POST /api/session/:id/rectangle?gen=` | 源像素矩形 → 天球中心/角尺寸 |
| `POST /api/session/:id/cutout/preview?gen=` | JSON 参数 → 实际裁切 PNG(base64)+覆盖率 |
| `POST /api/session/:id/cutout/file?gen=` | JSON 参数 → 独立 FITS 下载 |

错误均为 JSON：`{error:true, code, message}`，HTTP 状态与 code 对应，例如
`MALFORMED_HEADER(400)`、`UNSUPPORTED_BITPIX(400)`、`UNSUPPORTED_NAXIS(400)`、
`UNSUPPORTED_WCS(400)`、`SINGULAR_CD(400)`、`DIMENSION_OVERFLOW(400)`、
`TRUNCATED_DATA(400)`、`FILE_TOO_LARGE(413)`、`BAD_CUTOUT(400)`、
`UNKNOWN_SESSION(404)`、`STALE_GENERATION(409)`、`NOT_FOUND(404)`。

## 目录

```
server/index.js   HTTP 服务与接口（Node 内置模块）
lib/fits.js       80 字节头卡片解析、大端 Int16/Float32 读写、2880 对齐、FITS 写出
lib/wcs.js        CD 矩阵校验/求逆、TAN 正逆投影、像素↔天球
lib/cutout.js     输出中心最近邻重采样、缺失统计、CRPIX 重定位、导出 FITS
lib/grid.js       服务端 RA/Dec 网格（处理 RA 环绕与半球边缘断线）
lib/render.js     物理值→RGBA、透明缺失、服务端 PNG 概览
lib/png.js        零依赖 PNG 编码器（zlib）
lib/sample.js     代码生成的 Int16 / Float32 测试样本
public/           工作区页面（拖拽/缩放/框选、读数、切片表单、服务端预览）
test/             node:test 单元测试与 HTTP 端到端测试
```
