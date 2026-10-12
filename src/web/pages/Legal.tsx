import type { VNode } from "preact";
import type { Lang } from "../../shared/i18n";
import { Page } from "../components";
import { useI18n } from "../i18n";

/** Where people write about their data or these terms; shown on both pages. */
export const CONTACT_EMAIL = "likefudan@gmail.com";
/** When either page last changed in substance; update it with the text. */
const UPDATED = "2026-10-12";

/** Paragraphs and items are text with links written [label](href). */
type Section = { heading: string; paragraphs: string[]; items?: string[] };
type Doc = { title: string; intro: string; sections: Section[] };

const mail = `[${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL})`;
const permissions = "[myaccount.google.com/permissions](https://myaccount.google.com/permissions)";

const PRIVACY: Record<Lang, Doc> = {
  en: {
    title: "Privacy Policy",
    intro:
      "wisesplit (wisesplit.llmat.dev) is a small, non-commercial website for splitting shared expenses within groups of friends. This policy explains what we collect, why, who processes it for us, and how to have it deleted.",
    sections: [
      {
        heading: "What we collect",
        paragraphs: [],
        items: [
          "From your Google account, when you sign in with Google: your name, email address, profile picture URL, and Google's account ID for you (scopes: openid, email, profile). We do not get your Google password and do not access your contacts, Gmail, Drive, calendar or any other Google data.",
          "What you enter: your display name, an optional Venmo username, your language, and your notification settings.",
          "Group data you and other members enter: groups and their members, expenses (description, amount, date, who paid and how it is split), payments between members, and the history of changes to them.",
          "Receipt photos you choose to attach to an expense.",
          "If you turn on push notifications: the push subscription your browser gives us (an endpoint address and keys), so we can send notifications to that device.",
          "A sign-in cookie that keeps you signed in for up to 30 days (we store only a hash of it), and your language choice in your browser's local storage. We use no advertising or analytics cookies.",
          "Basic request logs (such as IP address, browser type and the page requested), kept by our hosting provider for security and troubleshooting.",
        ],
      },
      {
        heading: "How we use it",
        paragraphs: [
          "Only to run wisesplit: to sign you in, let the site admin review new sign-ups (the admin sees the name and email of everyone who signs up), show your name and picture to the members of your groups, calculate who owes whom, build Venmo payment links, and send you the in-app, email and push notifications you have turned on. Members of a group can see that group's expenses, payments and receipt photos, and can export them as a CSV file.",
          "We do not sell, rent or share your personal information for advertising or marketing, we show no ads, and we do not use your data to train AI models.",
        ],
      },
      {
        heading: "Google user data",
        paragraphs: [
          "wisesplit's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements. We use your Google name, email and picture only to provide the features described above, and do not transfer them to anyone except the service providers below as needed to run the site, or as required by law.",
        ],
      },
      {
        heading: "Service providers",
        paragraphs: ["We rely on these providers, who process data only on our behalf:"],
        items: [
          "Cloudflare: hosting (Workers), database (D1), receipt photo storage (R2), and the Turnstile human check on the sign-up form.",
          "Resend: delivering notification emails to your email address.",
          "Your browser's push service (for example Google, Apple or Mozilla): delivering push notifications, if you turn them on. The notification content is encrypted.",
          "Google: signing you in, and serving your profile picture.",
        ],
      },
      {
        heading: "How long we keep it",
        paragraphs: [
          "Your account and group data are kept while you use wisesplit. Notifications are deleted after 180 days, expired sign-in sessions are removed, and receipt photos are deleted when their expense or group is deleted.",
        ],
      },
      {
        heading: "Your choices and deleting your data",
        paragraphs: [
          `You can change your name, Venmo username, language and notification settings on your profile at any time, and you can revoke wisesplit's access to your Google account at ${permissions}. To get a copy of your data or have your account deleted, email ${mail} from the address you sign in with. We will delete your account and personal information (name, email, picture, Venmo username, push subscriptions) within 30 days. Expenses you shared with others stay in their groups so their balances remain correct, but no longer show your personal information.`,
        ],
      },
      {
        heading: "Security",
        paragraphs: [
          "All traffic uses HTTPS, and groups, expenses and receipt photos are only shown to members of their group. No system is perfectly secure, but we take reasonable steps to protect your data.",
        ],
      },
      {
        heading: "Children",
        paragraphs: ["wisesplit is not intended for children under 13, and we do not knowingly collect their data."],
      },
      {
        heading: "Changes and contact",
        paragraphs: [
          `If we change this policy, we will update this page and the date below. Questions or requests: ${mail}.`,
        ],
      },
    ],
  },
  zh: {
    title: "隐私政策",
    intro:
      "wisesplit（wisesplit.llmat.dev）是一个小型、非商业的网站，用于朋友之间在群组内分摊共同开支。本政策说明我们收集哪些信息、为什么收集、由谁替我们处理，以及如何删除。",
    sections: [
      {
        heading: "我们收集的信息",
        paragraphs: [],
        items: [
          "用 Google 登录时，来自你 Google 账号的：姓名、邮箱地址、头像链接，以及 Google 为你分配的账号 ID（授权范围：openid、email、profile）。我们拿不到你的 Google 密码，也不会访问你的联系人、Gmail、云端硬盘、日历或其他任何 Google 数据。",
          "你自己填写的：显示名称、可选的 Venmo 用户名、语言，以及通知设置。",
          "你和其他成员录入的群组数据：群组及其成员、账目（说明、金额、日期、谁付款以及如何分摊）、成员之间的付款，以及这些记录的修改历史。",
          "你选择附在账目上的收据照片。",
          "如果你开启推送通知：你的浏览器提供的推送订阅信息（一个推送地址和密钥），用于向该设备发送通知。",
          "一个让你保持登录最长 30 天的登录 Cookie（我们只保存它的哈希值），以及保存在浏览器本地存储里的语言选择。我们不使用任何广告或统计 Cookie。",
          "基本的访问日志（如 IP 地址、浏览器类型、访问的页面），由托管服务商保存，用于安全和排查问题。",
        ],
      },
      {
        heading: "我们如何使用这些信息",
        paragraphs: [
          "仅用于运行 wisesplit：让你登录、让网站管理员审核新注册（管理员能看到所有注册者的名称和邮箱）、向你所在群组的成员显示你的名字和头像、计算谁欠谁多少、生成 Venmo 付款链接，以及发送你开启的站内、邮件和推送通知。群组成员可以看到该群组的账目、付款和收据照片，并可将其导出为 CSV 文件。",
          "我们不会出售、出租你的个人信息，也不会将其用于广告或营销；网站没有广告，也不会用你的数据训练 AI 模型。",
        ],
      },
      {
        heading: "Google 用户数据",
        paragraphs: [
          "wisesplit 对从 Google API 获得的信息的使用以及向任何其他应用的传输，将遵守《Google API 服务用户数据政策》（Google API Services User Data Policy），包括其中的“有限使用”（Limited Use）要求。你的 Google 姓名、邮箱和头像仅用于提供上述功能；除为运行网站所需提供给下列服务商，或法律要求外，不会传给任何人。",
        ],
      },
      {
        heading: "服务提供商",
        paragraphs: ["我们依赖以下服务商，它们仅代表我们处理数据："],
        items: [
          "Cloudflare：网站托管（Workers）、数据库（D1）、收据照片存储（R2），以及注册表单上的 Turnstile 人机验证。",
          "Resend：向你的邮箱发送通知邮件。",
          "你的浏览器所用的推送服务（如 Google、Apple 或 Mozilla）：在你开启后递送推送通知，通知内容经过加密。",
          "Google：登录验证，以及提供你的头像图片。",
        ],
      },
      {
        heading: "保存期限",
        paragraphs: [
          "你使用 wisesplit 期间，账号和群组数据会一直保留。通知在 180 天后删除，过期的登录会话会被清除，账目或群组删除时其收据照片也会被删除。",
        ],
      },
      {
        heading: "你的选择与删除数据",
        paragraphs: [
          `你可以随时在个人资料页修改名称、Venmo 用户名、语言和通知设置，也可以在 ${permissions} 撤销 wisesplit 对你 Google 账号的访问权限。如需获取你的数据副本或删除账号，请用你登录所用的邮箱发邮件到 ${mail}。我们会在 30 天内删除你的账号和个人信息（名称、邮箱、头像、Venmo 用户名、推送订阅）。你与他人共同的账目会保留在对方的群组中，以保证他们的余额正确，但不再显示你的个人信息。`,
        ],
      },
      {
        heading: "安全",
        paragraphs: [
          "所有通信都使用 HTTPS，群组、账目和收据照片只向该群组的成员显示。没有系统是绝对安全的，但我们会采取合理措施保护你的数据。",
        ],
      },
      {
        heading: "儿童",
        paragraphs: ["wisesplit 不面向 13 岁以下的儿童，我们不会有意收集他们的数据。"],
      },
      {
        heading: "变更与联系方式",
        paragraphs: [`如本政策有变更，我们会更新本页面和下方的日期。如有问题或请求，请联系：${mail}。`],
      },
    ],
  },
};

const TERMS: Record<Lang, Doc> = {
  en: {
    title: "Terms of Service",
    intro:
      "These terms apply to your use of wisesplit (wisesplit.llmat.dev), a free, non-commercial website for splitting shared expenses within groups of friends. By using wisesplit you agree to them.",
    sections: [
      {
        heading: "Accounts",
        paragraphs: [
          "You sign in with a Google account. New accounts may need approval by the site admin, who can decline or deactivate any account. Keep your Google account secure; you are responsible for what is done with your account.",
        ],
      },
      {
        heading: "What wisesplit does and does not do",
        paragraphs: [
          "wisesplit is a record-keeping tool. It calculates balances from what group members enter, and can open a Venmo link with an amount filled in. It does not hold, send or receive money, and it is not a bank or payment service. Payments happen outside wisesplit, between members, under the terms of whatever service they use. Check amounts before paying; we are not responsible for payments made, missed or disputed between members.",
        ],
      },
      {
        heading: "Your content",
        paragraphs: [
          "You keep ownership of what you enter, including receipt photos. You let us store it and show it to the members of the group it belongs to, only to run the service. Only enter information and upload photos you have the right to share with your group.",
        ],
      },
      {
        heading: "Acceptable use",
        paragraphs: [
          "Do not use wisesplit for anything illegal, to harass others, to upload harmful or unlawful content, or to try to break, overload or get unauthorized access to the site. We may remove content or deactivate accounts that break these terms.",
        ],
      },
      {
        heading: "Availability and changes",
        paragraphs: [
          'wisesplit is provided free of charge, "as is" and "as available", without warranties of any kind. We may change, suspend or stop the service at any time; we will try to give notice so you can export your groups\' data first.',
        ],
      },
      {
        heading: "Limitation of liability",
        paragraphs: [
          "To the extent the law allows, we are not liable for any indirect or consequential loss, or for any loss of data or money, arising from your use of wisesplit.",
        ],
      },
      {
        heading: "Privacy",
        paragraphs: ["How we handle your data is described in our [Privacy Policy](/privacy)."],
      },
      {
        heading: "Changes and contact",
        paragraphs: [
          `We may update these terms; the date below shows the latest version, and using wisesplit after a change means you accept it. Questions: ${mail}.`,
        ],
      },
    ],
  },
  zh: {
    title: "服务条款",
    intro:
      "本条款适用于你对 wisesplit（wisesplit.llmat.dev）的使用。wisesplit 是一个免费、非商业的网站，用于朋友之间在群组内分摊共同开支。使用 wisesplit 即表示你同意本条款。",
    sections: [
      {
        heading: "账号",
        paragraphs: [
          "你使用 Google 账号登录。新账号可能需要网站管理员审核，管理员可以拒绝或停用任何账号。请保管好你的 Google 账号；通过你的账号进行的操作由你负责。",
        ],
      },
      {
        heading: "wisesplit 做什么、不做什么",
        paragraphs: [
          "wisesplit 是一个记账工具。它根据群组成员录入的内容计算余额，并可以打开一个预填好金额的 Venmo 链接。它不持有、不发送也不接收任何资金，不是银行或支付服务。付款在 wisesplit 之外由成员之间完成，适用你们所用服务的条款。付款前请核对金额；对于成员之间已付、漏付或有争议的款项，我们不承担责任。",
        ],
      },
      {
        heading: "你的内容",
        paragraphs: [
          "你录入的内容（包括收据照片）归你所有。你允许我们保存这些内容，并仅为运行本服务向其所属群组的成员显示。请只录入和上传你有权与群组分享的信息和照片。",
        ],
      },
      {
        heading: "使用规范",
        paragraphs: [
          "不得将 wisesplit 用于任何违法用途、骚扰他人、上传有害或违法内容，或试图破坏、使网站超负荷、未经授权访问网站。对违反本条款的内容或账号，我们可以删除内容或停用账号。",
        ],
      },
      {
        heading: "服务可用性与变更",
        paragraphs: [
          "wisesplit 免费提供，按“现状”和“现有”提供，不作任何形式的保证。我们可能随时修改、暂停或停止服务；我们会尽量提前通知，以便你先导出群组数据。",
        ],
      },
      {
        heading: "责任限制",
        paragraphs: [
          "在法律允许的范围内，对于因使用 wisesplit 造成的任何间接或后果性损失，或任何数据或金钱损失，我们不承担责任。",
        ],
      },
      {
        heading: "隐私",
        paragraphs: ["我们如何处理你的数据，请见[隐私政策](/privacy)。"],
      },
      {
        heading: "变更与联系方式",
        paragraphs: [
          `我们可能会更新本条款；下方日期为最新版本，变更后继续使用 wisesplit 即表示你接受变更。如有问题：${mail}。`,
        ],
      },
    ],
  },
};

/** Text with its [label](href) links made into links. */
function Rich({ text }: { text: string }) {
  const parts: (string | VNode)[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const [, label, href = ""] = m;
    parts.push(text.slice(last, m.index));
    parts.push(
      <a key={m.index} href={href} {...(/^https?:/.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {label}
      </a>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** One of the two policy pages; both are public, with no sign-in needed. */
function LegalPage({ docs }: { docs: Record<Lang, Doc> }) {
  const { lang, t } = useI18n();
  const doc = docs[lang];
  return (
    <Page title={doc.title}>
      <div class="legal">
        <p>{doc.intro}</p>
        {doc.sections.map((s) => (
          <section key={s.heading}>
            <h2>{s.heading}</h2>
            {s.paragraphs.map((p) => (
              <p key={p}>
                <Rich text={p} />
              </p>
            ))}
            {s.items && (
              <ul>
                {s.items.map((item) => (
                  <li key={item}>
                    <Rich text={item} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        <p class="muted small">{t("legal.updated", { date: UPDATED })}</p>
      </div>
    </Page>
  );
}

export const Privacy = () => <LegalPage docs={PRIVACY} />;
export const Terms = () => <LegalPage docs={TERMS} />;
