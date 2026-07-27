import { useParams } from "react-router-dom";
import Nav from "../components/Nav";
import Footer from "../components/Footer";
import { findPost } from "../posts";
import "./blog.css";

export default function Post() {
  const { slug } = useParams<{ slug: string }>();
  const post = findPost(slug);

  if (!post) {
    return (
      <>
        <Nav />
        <main id="main" className="blog-page">
          <div className="wrap">
            <h1 className="b-title">Post not found</h1>
            <p className="b-desc">
              That post doesn't exist, or its link has changed.{" "}
              <a href="/blog">See everything published</a>.
            </p>
          </div>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Nav />
      <main id="main" className="blog-page">
        <article className="wrap b-post">
          <header className="b-post-head">
            <h1 className="b-title">{post.title}</h1>
            <p className="b-meta">
              <time dateTime={post.date}>{post.dateDisplay}</time>
            </p>
          </header>
          {/* Rendered at build time by scripts/build-posts.mjs from markdown in
              content/posts/. The input is authored in this repo, not user input. */}
          <div className="b-body" dangerouslySetInnerHTML={{ __html: post.html }} />
        </article>
        <div className="wrap b-back">
          <a href="/blog">← All posts</a>
        </div>
      </main>
      <Footer />
    </>
  );
}
