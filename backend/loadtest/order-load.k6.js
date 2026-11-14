/**
 * k6 load test — luồng gọi món (POST /api/orders) dưới tải kéo dài.
 *
 * Mô phỏng giờ cao điểm: 50 khách đồng thời gọi món liên tục vào một số ít bàn
 * (nhiều request tranh chấp cùng một bàn). Mỗi request mang X-Forwarded-For riêng
 * (mỗi khách một thiết bị) để rate limiter theo IP không che mất kết quả.
 *
 * Chuẩn bị bàn test:  node loadtest/prepare-tables.js 20   → in ra TABLE_IDS và ITEM_ID
 * Chạy (Docker):
 *   docker run --rm -i -e BASE_URL=http://host.docker.internal:4000 \
 *     -e TABLE_IDS=... -e ITEM_ID=... grafana/k6:0.54.0 run - < loadtest/order-load.k6.js
 */
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
const TABLE_IDS = (__ENV.TABLE_IDS || "").split(",").filter(Boolean);
const ITEM_ID = __ENV.ITEM_ID;
const VUS = Number(__ENV.VUS || 50);

const newOrders = new Counter("orders_created");
const mergedOrders = new Counter("orders_merged");

export const options = {
  scenarios: {
    rush_hour: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: VUS },
        { duration: "30s", target: VUS },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export function setup() {
  if (TABLE_IDS.length === 0 || !ITEM_ID) throw new Error("Cần TABLE_IDS và ITEM_ID (xem loadtest/prepare-tables.js)");
}

export default function () {
  const tableId = TABLE_IDS[Math.floor(Math.random() * TABLE_IDS.length)];
  const ip = `10.${__VU % 250}.${Math.floor(__ITER / 250) % 250}.${__ITER % 250}`;
  const res = http.post(
    `${BASE_URL}/api/orders`,
    JSON.stringify({ tableId, items: [{ itemId: ITEM_ID, quantity: 1 }] }),
    { headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, timeout: "10s" }
  );

  const ok = check(res, { "status 201": (r) => r.status === 201 });
  if (ok) {
    if (res.json("data.is_new_order")) newOrders.add(1);
    else mergedOrders.add(1);
  }
}
