import Nav from "../components/Nav";
import Footer from "../components/Footer";
import { posts } from "../posts";
import "./blog.css";

export default function Blog() {
  return (
    <>
      <Nav />
      <main id="main" className="blog-page">
        <div className="wrap">
          <p className="eyebrow">Writing</p>
          <h1 className="b-title">Notes on building</h1>
          <p className="lede">
            Working notes on AI-native tooling — what I built, what it measured, and what broke.
          </p>

          {posts.length === 0 ? (
            <p className="b-empty">Nothing published yet.</p>
          ) : (
            <ul className="b-list">
              {posts.map((post) => (
                <li key={post.slug} className="b-item">
                  <h2 className="b-item-title">
                    <a href={`/blog/${post.slug}`}>{post.title}</a>
                  </h2>
                  <p className="b-meta">
                    <time dateTime={post.date}>{post.dateDisplay}</time>
                  </p>
                  <p className="b-desc">{post.description}</p>
                  {post.tags.length > 0 && (
                    <div className="chips">
                      {post.tags.map((tag) => (
                        <span key={tag} className="chip">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
