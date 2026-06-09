# BlockOps AWS backend

Backend này dùng một Lambda cho các route:

| Method | Route | Chức năng |
|---|---|---|
| `GET` | `/status` | Trạng thái EC2, IP, uptime |
| `POST` | `/start` | Bật EC2 |
| `POST` | `/stop` | Tắt EC2 |
| `POST` | `/restart-instance` | Reboot toàn bộ EC2 |
| `POST` | `/restart-server` | Restart riêng `minecraft.service` qua SSM |

## 1. Chuẩn bị EC2

Gắn IAM role có managed policy `AmazonSSMManagedInstanceCore` vào EC2. Đảm bảo
SSM Agent đang chạy và instance xuất hiện trong **Systems Manager > Fleet Manager**.

Cài Minecraft dưới user `minecraft` tại `/opt/minecraft`, sau đó:

```bash
sudo cp minecraft.service /etc/systemd/system/minecraft.service
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft.service
```

Sửa `User`, `WorkingDirectory`, RAM và tên file jar trong service nếu máy đang dùng
cấu trúc khác. Khi EC2 boot, systemd sẽ tự bật Minecraft. Khi EC2 shutdown,
`SIGINT` cho server cơ hội lưu world trước khi dừng.

## 2. Đóng gói Lambda Node.js

AWS Lambda có sẵn AWS SDK v3, nhưng đóng gói hai client đang sử dụng giúp khóa
dependency theo `package-lock.json` và tránh thay đổi ngoài ý muốn khi runtime
được cập nhật.

Trong thư mục `aws`:

```bash
npm install
zip -r blockops-lambda.zip index.mjs package.json package-lock.json node_modules
```

`npm install` lần đầu tạo `package-lock.json`. Những lần build sau dùng:

```bash
npm ci --omit=dev
zip -r blockops-lambda.zip index.mjs package.json package-lock.json node_modules
```

## 3. Tạo Lambda

1. Tạo Lambda runtime **Node.js 24.x**, architecture `arm64` hoặc `x86_64`.
2. Upload `blockops-lambda.zip`.
3. Handler: `index.handler`.
4. Timeout: 15 giây.
5. Memory: 128 MB là đủ cho workload này.
6. Thêm environment variables:

```text
INSTANCE_ID=i-0123456789abcdef0
MINECRAFT_SERVICE=minecraft.service
MINECRAFT_PORT=25565
MINECRAFT_VERSION=1.21.x
SERVER_ADDRESS=mc.example.com
ALLOWED_ORIGIN=https://ten-mien-dashboard.example
CONTROL_TOKEN=mot-token-dai-ngau-nhien
STATUS_CACHE_TTL=15
```

`SERVER_ADDRESS` có thể để trống để Lambda trả public DNS/IP của EC2. Nếu EC2
thường xuyên đổi IP, nên dùng Elastic IP hoặc Route 53.

Gắn AWS managed policy `AWSLambdaBasicExecutionRole` để ghi CloudWatch Logs.
Tạo thêm inline policy từ `lambda-iam-policy.json`, thay ba placeholder:
`AWS_REGION`, `AWS_ACCOUNT_ID`, `INSTANCE_ID`.

Nếu chỉ dùng Lambda Console code editor, có thể upload riêng `index.mjs` vì
runtime Node.js có sẵn AWS SDK v3. Với production nên dùng file zip có dependency.

## 4. Tạo API Gateway

Tạo **HTTP API**, Lambda proxy integration payload format `2.0`, rồi tạo routes:

```text
GET  /status
POST /start
POST /stop
POST /restart-instance
POST /restart-server
```

Cấu hình CORS:

```text
Allow origins: https://ten-mien-dashboard.example
Allow methods: GET, POST, OPTIONS
Allow headers: content-type, x-control-token
```

Có thể dùng route `$default` trỏ vào Lambda thay vì tạo từng route; Lambda vẫn
từ chối mọi path không nằm trong allowlist.

## 5. Kết nối dashboard

Mở nút bánh răng trên dashboard:

1. Dán Invoke URL của HTTP API.
2. Dán cùng giá trị `CONTROL_TOKEN`.
3. Nhấn **Lưu cấu hình**.

Dashboard chỉ gọi `/status` khi có client mở trang, bấm **Làm mới**, hoặc tab
đang visible đến chu kỳ refresh; tab ẩn không poll Lambda. Dashboard cache
`/status` trong 60 giây. Lambda cache `DescribeInstances` trong 15 giây trên
execution environment đang warm. Nút **Làm mới** luôn bỏ qua cache trình duyệt.

`/status` trả thêm `publicIp`, `publicDns`, `privateIp`; dashboard ưu tiên
`publicIp` để hiển thị địa chỉ IPv4 dùng connect Minecraft. `players` hiện là
placeholder `-- / --`, chưa query trực tiếp Minecraft server.

## Bảo mật

`CONTROL_TOKEN` phù hợp cho dashboard cá nhân nhưng vẫn là bearer token lưu trong
trình duyệt. Không commit token vào repo. Với dashboard nhiều người dùng, thay
cơ chế này bằng API Gateway JWT authorizer (Cognito/OIDC), CloudFront + WAF, và
giới hạn `ALLOWED_ORIGIN`; không để `*` trong production.
