import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
/** Raw HTML is skipped so generated content cannot inject markup. */
export function Markdown({ text }: { text: string }) {
  return <div className="space-y-2 break-words text-sm [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown></div>;
}
