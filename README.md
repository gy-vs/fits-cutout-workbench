# FITS cutout workbench

一个完全在本机运行的二维 FITS 图像切片工作台。浏览器选择 FITS 文件后，服务端读取
primary HDU 的 2880 字节头块与二维像素数据，页面显示整图概览、由服务端 WCS 计算的
赤经/赤纬坐标网格、鼠标指向的像素与天球坐标；可以拖动画出/调整切片区域，以
“天球中心 + 角尺寸 + 输出像素尺寸”请求切片，并下载一份坐标参考点已随切片重定位、
可被 astropy/cfitsio/ds9 等常见读取器打开的独立 FITS 文件。

不需要数据库、云服务或外部账号；上传字节只存在于本进程内存中，替换文件、页面关闭
或空闲 30 分钟后释放。

## 运行要求

- Node.js >= 18（开发使用 Node 20）
- **零运行时依赖**，无需 `npm install`

```bash
npm start                 # http://localhost:3000
PORT=8080 npm start       # 换端口
MAX_UPLOAD_MB=128 npm start
npm test                  # 运行全部内置测试（node --test）
npm run make-sample       # 重新生成 samples/ 下的三份小样本
```

首屏直接是上传与操作工作区，没有介绍性首页。

## 支持范围（严格限定，不符合即明确拒绝）

- primary HDU：`SIMPLE=T`，`NAXIS=2`
- `BITPIX=16`（整型，支持 `BSCALE`/`BZERO`/`BLANK`）或 `BITPIX=-32`（IEEE float）
- WCS：`CRPIX1/2`、`CRVAL1/2`、`CD1_1…CD2_2` 描述的 RA/DEC **TAN（gnomonic）**投影
- 明确**拒绝** `CDELTn + PCi_j` 约定（返回 `UNSUPPORTED_WCS_CONVENTION` 并在页面说明，
  绝不按错误坐标导出），同样拒绝非 TAN 投影、不可逆 CD 矩阵、缺必需关键字等情况
- 头：80 字节卡片、字符串引号（含 `''` 转义）与注释斜线区分解析，`END` 后按 2880 字节对齐
- 像素大端序（big-endian）

### 缺失值统一规则（屏幕采样与导出一致）

- 整型：存储值等于 `BLANK` → 缺失（NaN）；其余物理值 = `raw * BSCALE + BZERO`
- 浮点：存储为 NaN → 缺失
- 导出统一为 `BITPIX=-32`，物理值直接写出，缺失写 NaN（不再带 BSCALE/BZERO/BLANK）

### 重采样策略（输出分辨率与源网格不同时有唯一定义）

- 输出以**请求的天球中心为新切点**建立自己的 TAN 切平面；每个输出像素中心经
  “输出像素 → 天球（TAN）→ 源像素（逆 TAN + CD）”映射后，在源图上做**双线性插值**
- 不做外推：中心落在源像素网格之外 → NaN；落在 TAN 可见半球之外 → 该像素 NaN
  （区域中心完全在半球外则返回 `REGION_OUTSIDE_HEMISPHERE`）
- 双线性插值中 NaN 邻居权重归零并重新归一化；四个邻居全缺失 → NaN
- 输出 `CRPIX` 位于输出网格中心、`CRVAL` 为请求中心，CD 按源 CD 列方向与请求角尺寸构造，
  因此下载文件的坐标不会沿用原图 CRPIX 而产生漂移

## 操作方式

- 滚轮：以鼠标为锚点缩放；框外拖动：平移；双击：复位
- 框内拖动：移动切片区域；拖动四角手柄：改变切片区域；Ctrl/⌘+拖动画新框
- 右侧面板可手工编辑中心 RA/Dec、角宽/角高、输出像素宽/高后直接请求
- 橙色框是“待导出范围”，绿色多边形是**服务端实际裁切**回投到源图的覆盖范围
  （边界、旋转、半球边缘处两者可能不同）
- 右侧预览、统计（尺寸、缺失比例、重定位后的 CRPIX、服务器回读中心）均来自
  服务端返回的真实像素，不是客户端画的假范围

## 竞态与资源释放

- 上传新文件会使旧文件的全部进行中/已返回响应失效（前端 generation 令牌 + abort）
- 连续改变区域：每个切片请求带单调 `seq`；前端取消旧请求，服务端发现已有更新序号时
  中止计算并返回 **409 `STALE_RESPONSE`**，旧结果不会覆盖新图坐标和预览
- “释放当前文件”按钮、替换文件、页面 `pagehide`（sendBeacon）都会调用 release；
  另有 30 分钟空闲回收与最多 8 个会话的 LRU 淘汰

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/fits` | body 为 FITS 二进制（`x-file-name` 可带文件名），返回会话 id、尺寸、WCS |
| `GET` | `/api/fits/:id/overview` | Float32 小端概览像素（头部带宽高/vmin/vmax/NaN 数） |
| `GET` | `/api/fits/:id/grid` | 服务端计算的 RA/Dec 经纬线（源像素坐标折线） |
| `GET` | `/api/fits/:id/point?x&y` | 指定像素的物理值、缺失标记、RA/Dec |
| `POST` | `/api/fits/:id/region` | 源像素矩形 → 天球中心、切平面角尺寸、建议输出像素 |
| `POST` | `/api/fits/:id/cutout?ra&dec&widthDeg&heightDeg&outW&outH&seq` | 计算切片（job） |
| `GET` | `/api/jobs/:jobId/preview` | 切片的 Float32 小端预览 |
| `GET` | `/api/jobs/:jobId/download` | 独立 FITS 文件下载 |
| `POST` | `/api/fits/:id/release` | 立即释放会话内存 |

可区分错误码：`EMPTY_UPLOAD`、`PAYLOAD_TOO_LARGE`(413)、`UNSUPPORTED_MEDIA`、
`MALFORMED_HEADER`、`NOT_PRIMARY_IMAGE`、`UNSUPPORTED_BITPIX`、`UNSUPPORTED_NAXIS`、
`MISSING_WCS`、`UNSUPPORTED_WCS_CONVENTION`、`UNSUPPORTED_PROJECTION`、
`SINGULAR_CD_MATRIX`、`INVALID_WCS_VALUE`、`DIMENSION_PRODUCT_OVERFLOW`、
`TRUNCATED_DATA`、`SESSION_NOT_FOUND`(404)、`BAD_REQUEST`、`OUTPUT_TOO_LARGE`、
`REGION_OUTSIDE_HEMISPHERE`(422)、`STALE_RESPONSE`(409)。

## 测试

`npm test` 使用代码生成的内存 FITS 与三份 `samples/` 样本，覆盖：

- 80 字节卡片解析、引号/注释斜线、2880 对齐、大端序、END 截断、畸形头
- BSCALE/BZERO/BLANK 与 NaN 的缺失值规则
- TAN 正/逆投影往返、旋转 CD、RA=0 跨越、北极附近、可见半球边缘、奇异 CD
- 双线性重采样、缺失权重、越界 NaN、不同输出网格下 NaN 语义保留
- 切片输出 CRPIX 重定位、下载文件重新解析后坐标与请求中心一致
- 端到端：上传 → point 读数 → region → cutout → 下载 → 重新解析坐标往返；
  CDELT+PC 拒绝、输出过大、半球外、超大上传 413、空上传 400、过期请求 409、release 失效
- 同一份样本上验证“服务端中心坐标 = 页面 point 接口读数 = 导出文件重读坐标”

## 项目结构

```
server/server.js      零依赖 HTTP 服务与会话编排
lib/fits-parser.js    FITS 头/数据严格解析与校验
lib/fits-writer.js    独立 float32 FITS 写出（2880 对齐）
lib/wcs.js            RA/DEC TAN 投影、CD 线性变换
lib/pixels.js         缺失值规则、双线性重采样、概览降采样、切片物化
lib/grid.js           服务端经纬线网格
lib/cutout.js         区域几何、参数校验、切片预览
lib/sessions.js       纯内存会话与空闲淘汰
public/               工作区前端（原生 JS + Canvas）
scripts/make-sample.js 生成小尺寸测试样本
test/                 node --test 测试
samples/              生成的 float / int16 / RA=0 跨越样本
```
