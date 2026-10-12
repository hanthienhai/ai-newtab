# AI Homepage chạy bằng Claude Code

**Tab mới tự đọc web giúp bạn, chạy bằng gói Claude Pro/Max, không cần API key.**

Extension này thay trang tab mới của Chrome (hoặc Edge) bằng một trang viết riêng
cho bạn. Một agent xem bạn hay vào trang nào, mở các trang đó ngay trong trình
duyệt của bạn (đã đăng nhập sẵn), rồi viết lại thành một trang chủ mới. Trang tự
dựng lại ở chế độ nền, nên mỗi lần mở tab mới bạn thấy tin gần nhất.

![Một trang chủ mẫu kiểu báo buổi sáng](docs/preview.png)
<sub>Ảnh minh hoạ. Trang của bạn dựng từ lịch sử duyệt web của bạn nên nội dung sẽ khác.</sub>

## Fork từ đâu

Repo này fork từ [**ThariqS/ai-newtab**](https://github.com/ThariqS/ai-newtab)
của Thariq Shihipar, giấy phép MIT. Ý tưởng, giao diện, cách xếp hạng lịch sử và
cách hiển thị trang trong iframe sandbox đều là của bản gốc. Lịch sử commit của
bản gốc vẫn giữ nguyên ở đây.

## Vì sao fork

Bản gốc gọi **Claude Managed Agents API**: bạn phải nhập API key và trả tiền theo
token cho mỗi lần dựng trang. Tôi có sẵn gói Claude Pro nên không muốn trả thêm
tiền API cho một tab mới.

Bản này đổi phần chạy agent sang **Claude Code** (`claude -p`) trên máy bạn, đăng
nhập bằng gói Claude của bạn. Không cần API key, không tốn tiền API; mỗi lần dựng
trang chỉ trừ vào hạn mức dùng của gói.

Những gì đã đổi so với bản gốc:

| Bản gốc | Bản này |
| --- | --- |
| Gọi Managed Agents API qua SDK `@anthropic-ai/sdk` | Gọi `claude -p` qua một native messaging host nhỏ (`apps/native-host/`) |
| Màn hình nhập API key | Bỏ; dùng phiên đăng nhập của Claude Code |
| Agent tự mở trang bằng công cụ trên server | Extension mở trang, dọn HTML, ghi vào thư mục tạm cho Claude đọc |
| Mặc định Claude Sonnet 5.5 | Mặc định Claude Haiku 5.5 (nhẹ hạn mức nhất) |
| Trang viết bằng tiếng Anh | Trang viết bằng tiếng Việt (đổi được trong Settings) |
| ID extension đổi theo máy | ID cố định `eadbpdogllalloacjcfbmijmfahjaflc` để host nhận ra extension |

> **Về quyền riêng tư.** Để dựng trang, extension đưa cho Claude Code trên máy bạn
> một bản tóm tắt lịch sử duyệt web (tên miền hay vào, số lượt, vài tiêu đề trang)
> và HTML đã dọn của tối đa 8 trang. Claude Code gửi chúng lên Claude. Các trang
> này mở bằng trình duyệt đã đăng nhập của bạn nên có thể chứa nội dung riêng tư.
> File trang nằm trong một thư mục tạm, bị xoá khi mỗi lượt chạy xong, và Claude
> Code được dặn không lưu transcript.
>
> Chrome có đồng bộ thì `chrome.history` trả cả lượt truy cập từ máy khác (điện
> thoại, laptop) cùng tài khoản, nên trang chủ có thể lấy tin từ những thiết bị đó.

---

## Cài đặt

Bạn cần:

- Chrome hoặc Edge
- [Node.js](https://nodejs.org) 20 trở lên
- [Claude Code](https://claude.com/claude-code), đăng nhập bằng gói Claude của bạn:

```bash
claude auth login
```

Rồi tải và build:

```bash
git clone https://github.com/hanthienhai/ai-newtab.git
cd ai-newtab
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
npx pnpm@10.11.1 host:install
```

(Máy đã có [pnpm](https://pnpm.io) thì `pnpm install && pnpm build && pnpm host:install` cũng được.)

`host:install` đăng ký host với Chrome và Edge cho tài khoản Windows/macOS/Linux
hiện tại: một khoá registry dưới `HKCU` trên Windows, một file JSON trên macOS và
Linux. Extension dùng host này để chạy `claude -p`.

**Chạy `host:install` từ một terminal bình thường** (PowerShell, Windows
Terminal, cmd), không chạy từ terminal của Claude Desktop. Xem lý do ở mục
[Khắc phục lỗi](#chrome-báo-specified-native-messaging-host-not-found).

Nạp extension vào Chrome:

1. Mở `chrome://extensions` (Edge: `edge://extensions`).
2. Bật **Developer mode** ở góc trên bên phải.
3. Bấm **Load unpacked**, chọn thư mục `apps/extension/.output/chrome-mv3`.

Chrome hỏi có giữ trang tab mới đã đổi không thì chọn **Keep it**.

Kiểm tra ID extension hiện trên thẻ extension là `eadbpdogllalloacjcfbmijmfahjaflc`.
ID khác thì host sẽ từ chối kết nối.

## Dùng lần đầu

1. Mở một tab mới, bấm **Build today's homepage**.
2. Màn hình tiến trình hiện từng bước: khởi động Claude Code, đọc lịch sử, chọn
   trang, mở trang trong trình duyệt, phân tích, viết trang chủ.

Lần đầu mất vài phút (thử với Haiku khoảng 4 phút). Bạn đóng tab giữa chừng cũng
được: việc dựng chạy trong service worker của extension và hiện lại ở bất kỳ tab
mới nào bạn mở.

## Tuỳ chỉnh

Bấm **⚙️ Settings** trên tab mới.

**Instructions.** Bạn viết gì ở đây cũng được đưa vào mọi lần dựng và được ưu tiên
hơn mặc định của agent. Ô này quyết định cả nội dung lẫn giao diện:

| Bạn viết | Bạn được |
| --- | --- |
| *"Kiểu báo buổi sáng. Chữ có chân, tiêu đề báo lớn, một bài chính, một cột tin ngắn."* | Trang nhất báo giấy |
| *"Một cột yên tĩnh. Không ảnh. Năm thứ đáng đọc, mỗi thứ một dòng lý do."* | Danh sách đọc gọn |
| *"Dashboard dày: PR và issue GitHub trước, rồi Hacker News, rồi phần còn lại."* | Bảng điều khiển công việc |
| *"Chữ xanh nền đen, font monospace, như BBS thập niên 80."* | Đúng như thế |
| *"Bỏ thể thao và chính trị. Luôn có thời tiết."* | Luật của bạn, ngày nào cũng áp |
| *"Write the page in English."* | Trang tiếng Anh thay vì tiếng Việt |

Bấm **Save & rebuild** để áp dụng ngay.

**Model.** Chọn model viết trang:

- **Claude Haiku 5.5** (mặc định): nhanh nhất, tốn hạn mức ít nhất.
- **Claude Sonnet 5.5**: biên tập tốt hơn, tốn hạn mức hơn.
- **Claude Opus 5.5**: kỹ nhất, tốn hạn mức nhất.

Model mới có hiệu lực từ lần dựng sau.

**Rebuild automatically.** Bật sẵn. Khi trang cũ hơn khoảng bạn chọn (6, 12, 24
hoặc 48 giờ), extension tự dựng lại ở chế độ nền. Chỉ chạy sau khi bạn đã dựng tay
một lần, và dựng hỏng thì đợi đến khoảng sau mới thử lại, không lặp vô hạn.

Nút **↻ Rebuild** ở góc trên bên phải dựng lại ngay.

## Nên biết

- **Hạn mức.** Mỗi lần dựng là hai lượt Claude Code trên gói của bạn. Đọc 8 trang
  tốn kha khá hạn mức của cửa sổ 5 giờ, Opus còn tốn hơn. Muốn để dành hạn mức cho
  việc khác thì dùng Haiku, chọn khoảng 24 giờ hoặc tắt tự dựng lại.
- **Chỉ dùng cá nhân.** Host chạy bản Claude Code của chính bạn. Đừng phát hành
  bản này cho người khác như một cách dùng gói Claude của họ.
- **Nó thấy gì.** Extension xếp hạng các trang trong lịch sử và mở tối đa 8 trang
  mỗi lần. Nó bỏ qua máy tìm kiếm, webmail, ngân hàng và trang giới thiệu khi chưa
  đăng nhập. Trang nào không mở được thì báo ra, không giấu.
- **Link là thật.** Mọi link trên trang lấy từ trang agent đã đọc. Agent được dặn
  không bịa URL.
- **Dựng bị ngắt.** Chrome đóng giữa chừng thì host dừng `claude` và bỏ lần dựng
  đó; bấm **↻ Rebuild** để chạy lại.
- **Cập nhật code.** Sau khi `git pull`, chạy lại `npx pnpm@10.11.1 build`, rồi bấm
  nút tải lại trên thẻ extension ở `chrome://extensions`.
- **Dời thư mục repo** thì chạy lại `host:install`, vì manifest ghi đường dẫn tuyệt đối.
- **Gỡ host:** `npx pnpm@10.11.1 host:uninstall`.

## Khắc phục lỗi

### Chrome báo "Specified native messaging host not found"

Chrome không tìm thấy host. Lần lượt kiểm tra:

1. **Đã chạy `host:install` chưa**, và chạy sau lần dời thư mục repo gần nhất chưa.
2. **Đã chạy từ terminal của một app MSIX chưa** (Windows). Claude Desktop là gói
   MSIX: khoá `HKCU` ghi từ shell của nó rơi vào registry riêng của gói, chỉ Chrome
   mở từ bên trong app mới thấy. Chrome bạn tự mở vẫn báo "not found". Cách sửa:
   mở PowerShell hoặc Windows Terminal bình thường, `cd` vào repo, chạy lại
   `npx pnpm@10.11.1 host:install`.

   Không mở được terminal ngoài (ví dụ đang nhờ Claude Desktop chạy giúp) thì ghi
   registry qua Task Scheduler, vì task chạy ngoài vùng ảo hoá của gói. Tạo file
   `reg-host.cmd` (sửa đường dẫn cho đúng máy bạn):

   ```bat
   reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ainewtab.claude" /ve /t REG_SZ /d "D:\path\to\ai-newtab\apps\native-host\com.ainewtab.claude.json" /f
   reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.ainewtab.claude" /ve /t REG_SZ /d "D:\path\to\ai-newtab\apps\native-host\com.ainewtab.claude.json" /f
   ```

   rồi chạy:

   ```bat
   schtasks /create /tn ainewtab-reg /sc once /st 23:59 /tr "C:\path\to\reg-host.cmd" /f
   schtasks /run /tn ainewtab-reg
   schtasks /delete /tn ainewtab-reg /f
   ```

   Muốn kiểm tra khoá đã có thật chưa thì cũng phải kiểm tra qua task hoặc
   terminal ngoài: `reg query` từ shell của app MSIX chỉ thấy bản ảo.
3. **Kiểm tra manifest** `apps/native-host/com.ainewtab.claude.json`: `path` phải
   trỏ tới `host.cmd` (Windows) hoặc `host.sh` có thật.
4. Khởi động lại Chrome hoàn toàn (thoát cả tiến trình chạy nền) rồi thử lại.

### "Access to the specified native messaging host is forbidden"

ID extension không khớp `allowed_origins` trong manifest. Kiểm tra ID trên
`chrome://extensions` là `eadbpdogllalloacjcfbmijmfahjaflc`. ID khác thường do bạn
nạp một bản build cũ hoặc build từ code gốc chưa có `key` trong manifest: chạy lại
`npx pnpm@10.11.1 build` rồi **Load unpacked** lại thư mục
`apps/extension/.output/chrome-mv3`.

### "Claude Code isn't logged in"

Chạy `claude auth login` trong terminal, đăng nhập bằng tài khoản có gói Pro/Max,
rồi bấm **↻ Rebuild**. Kiểm tra bằng `claude auth status`.

### "Claude Code helper exited"

Host khởi động được nhưng thoát giữa chừng. Thường do:

- **Đường dẫn `claude` hoặc `node` đổi** (cập nhật Claude Code, đổi bản Node qua
  nvm). `host:install` ghi cứng hai đường dẫn này vào `config.json` và `host.cmd`.
  Chạy lại `host:install`.
- **Node quá cũ.** Cần Node 20+.

Thử chạy host bằng tay để xem lỗi: `node apps/native-host/host.mjs` không được in gì
rồi đứng chờ; báo lỗi ngay là có vấn đề với Node hoặc file.

### Dựng hỏng với "claude exited (…) without a result" hoặc "claude: …"

`claude -p` chạy nhưng không trả kết quả. Nguyên nhân hay gặp:

- **Hết hạn mức gói.** Đợi cửa sổ 5 giờ mở lại, hoặc đổi sang Haiku.
- **Claude Code cần cập nhật.** Chạy `claude update`.
- Đọc phần lỗi đi kèm thông báo; host chép lại stderr của `claude`.

### Claude Code đòi duyệt quyền Write vào thư mục tạm (Windows)

Đã sửa trong bản này. Trên Windows, `os.tmpdir()` có thể trả đường dẫn 8.3 kiểu
`C:\Users\NGUYEN~1\...`; Claude Code coi đó là đường dẫn khác thư mục làm việc và
đòi duyệt tay. Host giờ đổi sang đường dẫn đầy đủ bằng `realpathSync.native`.
Vẫn gặp thì báo issue kèm đường dẫn thư mục tạm trong lỗi.

### Trang không dựng lại tự động

- Bạn phải dựng tay ít nhất một lần.
- Lần tự dựng trước hỏng thì extension đợi hết khoảng thời gian mới thử lại.
- Kiểm tra **Rebuild automatically** trong Settings còn bật.

### Xem log

- Log của service worker: `chrome://extensions` → thẻ extension → **Inspect views:
  service worker** → tab Console.
- Chạy thử agent ngoài Chrome với lịch sử mẫu:
  `npx -y bun@1.3.14 harness/run-agent.ts`.

## Cách hoạt động

1. Extension đọc `chrome.history` và xếp hạng các tên miền bạn hay vào.
2. **Lượt 1** (`claude -p`, không công cụ): Claude chọn tối đa 8 URL từ bản tóm tắt
   đó, trả về dạng structured output.
3. Extension mở các trang đó trong một cửa sổ nền và dọn HTML.
4. **Lượt 2** (`claude -p`, chỉ cho Read, Grep, Glob, Write): host ghi các trang vào
   một thư mục tạm mới; Claude đọc chúng và viết `homepage.tsx`.
5. Tab mới hiển thị component React đó trong một iframe sandbox.

Service worker của extension nói chuyện với `apps/native-host/host.mjs` qua Chrome
native messaging. Chrome khởi động host cho mỗi lượt và tắt nó khi cổng đóng, nên
huỷ lần dựng cũng dừng luôn `claude`. Thiết kế gốc dùng API của bản upstream nằm ở
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Giấy phép

MIT, giữ nguyên từ bản gốc. Xem [LICENSE](./LICENSE).
