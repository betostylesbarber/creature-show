// Captured-shape fixtures for tiktok-live-connector 2.5.0 / tiktok-live-proto 0.2.4 (v3 schema).
//
// Every fixture is built from the schema's own defaults (decode of an empty buffer), encoded with
// the installed protobuf encoder and decoded again with the connector's deserializeMessage(). So
// each fixture has exactly the shape the connector emits for that message type, including proto3
// defaults ("0" ids, 0 numbers, undefined sub-messages). A field name that does not exist in this
// version is dropped by the round trip, which the self-test below would catch.
//
// Not verifiable without a real LIVE (no stream available): the actual values TikTok puts in
// toUser / toMemberId for co-host gifts, whether groupId is unique per streak, whether
// common.msgId equals the push frame's msgId, the unit TikTok intends for diamondCount, and the
// room/info JSON fields used for the creator id and live start time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import * as P from "tiktok-live-connector";

const EMPTY = new Uint8Array(0);
const blank = (T) => T.decode(EMPTY);

export const ROOM = "7429000000000000001";
export const CREATOR = { userId: "6900000000000000001", uniqueId: "casadeselvin", nick: "Casa de Selvin" };
export const T0 = 1_761_200_000_000; // provider clock base (ms)

function roundtrip(name, obj) {
  const T = P[name];
  return P.deserializeMessage(name, Buffer.from(T.encode(obj).finish()));
}

// msgId, groupId and user ids are int64 in this schema. Tests use readable labels ("m1", "G1");
// num() maps a label to a stable positive int64 string (numeric strings pass through).
export function num(label) {
  const s = String(label ?? "0");
  if (/^\d+$/.test(s)) return s;
  let h = 0xcbf29ce484222325n;
  for (const ch of Buffer.from(s, "utf8")) h = BigInt.asUintN(64, (h ^ BigInt(ch)) * 0x100000001b3n);
  return BigInt.asUintN(63, h || 1n).toString();
}

export function image(url) {
  return { ...blank(P.ImageModel), urlList: url ? [url] : [] };
}

export function user({ id = "", nickname = "", displayId = "", avatar = null } = {}) {
  return { ...blank(P.User), id: id ? num(id) : "0", nickname, displayId, avatarThumb: avatar ? image(avatar) : undefined };
}

export function common({ msgId = "0", roomId = ROOM, createTime = T0 } = {}) {
  return { ...blank(P.CommonMessageData), msgId: num(msgId), roomId: num(roomId), createTime: String(createTime) };
}

export function giftStruct({ id = "5655", name = "Rose", diamondCount = 1, type = 1, url = "https://p16.example/rose.png" } = {}) {
  return { ...blank(P.Gift), id: String(id), name, diamondCount, type, image: image(url) };
}

export const VIEWERS = {
  ana: user({ id: "7000000000000000001", nickname: "Ana", displayId: "ana.k" }),
  bo: user({ id: "7000000000000000002", nickname: "Bo", displayId: "bo_b" }),
  cy: user({ id: "7000000000000000003", nickname: "Cy", displayId: "cy" }),
};

export function giftMessage({ msgId, createTime = T0, roomId = ROOM, sender = VIEWERS.ana, giftId = "5655", gift = giftStruct(), repeatCount = 1, repeatEnd = false, groupId = "0", toUser, toMemberIdInt = "0" } = {}) {
  return roundtrip("WebcastGiftMessage", {
    ...blank(P.WebcastGiftMessage),
    common: common({ msgId, roomId, createTime }),
    giftId: String(giftId),
    repeatCount,
    repeatEnd: repeatEnd ? 1 : 0,
    groupId: num(groupId),
    user: sender,
    toUser,
    toMemberIdInt: String(toMemberIdInt),
    gift: gift === null ? undefined : gift,
  });
}

export function chatMessage({ msgId, createTime = T0, roomId = ROOM, sender = VIEWERS.ana, content = "hello", isAnchor = false } = {}) {
  return roundtrip("WebcastChatMessage", {
    ...blank(P.WebcastChatMessage),
    common: common({ msgId, roomId, createTime }),
    user: sender,
    content,
    userIdentity: isAnchor ? { ...blank(P.UserIdentity), isAnchor: true } : undefined,
  });
}

export function likeMessage({ msgId, createTime = T0, sender = VIEWERS.ana, count = 5, total = "100" } = {}) {
  return roundtrip("WebcastLikeMessage", { ...blank(P.WebcastLikeMessage), common: common({ msgId, createTime }), user: sender, count, total: String(total) });
}

export function socialMessage({ msgId, createTime = T0, sender = VIEWERS.ana } = {}) {
  return roundtrip("WebcastSocialMessage", { ...blank(P.WebcastSocialMessage), common: common({ msgId, createTime }), user: sender });
}

// Self-test, only when this file itself is the test file being run.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  test("fixtures keep every field the adapter relies on (installed v3 schema)", () => {
    const g = giftMessage({ msgId: "1", repeatCount: 3, repeatEnd: true, groupId: "99", toUser: user({ id: CREATOR.userId, displayId: CREATOR.uniqueId }) });
    assert.equal(g.giftId, "5655");
    assert.equal(g.repeatCount, 3);
    assert.equal(g.repeatEnd, 1); // a number, not a boolean, in this version
    assert.equal(g.groupId, "99");
    assert.equal(g.gift.diamondCount, 1);
    assert.equal(g.gift.type, 1);
    assert.deepEqual(g.gift.image.urlList, ["https://p16.example/rose.png"]);
    assert.equal(g.user.id, VIEWERS.ana.id);
    assert.equal(g.user.displayId, "ana.k");
    assert.equal(g.toUser.id, CREATOR.userId);
    assert.equal(g.common.msgId, "1");
    assert.equal(g.common.createTime, String(T0));
    assert.equal(g.toMemberIdInt, "0");
    assert.equal("giftDetails" in g, false, "README's giftDetails does not exist in v3");
    assert.equal("uniqueId" in g.user, false, "README's user.uniqueId does not exist in v3");
    const c = chatMessage({ msgId: "2", content: "hi", isAnchor: true });
    assert.equal(c.content, "hi");
    assert.equal("comment" in c, false, "README's data.comment does not exist in v3");
    assert.equal(c.userIdentity.isAnchor, true);
    const l = likeMessage({ msgId: "3", count: 7 });
    assert.equal(l.count, 7);
    const empty = P.deserializeMessage("WebcastGiftMessage", Buffer.from([]));
    assert.equal(empty.common, undefined);
    assert.equal(empty.user, undefined);
    assert.equal(empty.giftId, "0");
  });
}
