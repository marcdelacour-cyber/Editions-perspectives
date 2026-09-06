(() => {
  "use strict";

  // TEST BUILD v10: Stripe Checkout points to the Vercel Preview backend.

  const STORAGE_KEY = "ep_cart_v2";
  const CHECKOUT_API = "https://editions-perspectives-checkout-afkdqda6z-editions-perspectives.vercel.app/api/create-checkout-session";
  const THRESHOLD_CENTS = 3500;
  const SHIPPING_LOW_CENTS = 300;
  const SHIPPING_HIGH_CENTS = 1;

  const PRODUCTS = Object.freeze({
    feedback:      { name: "Le Feedback en danse", price: 1800 },
    jugement:      { name: "Le jugement en danse", price: 2400 },
    imprevu:       { name: "Prévoir l’imprévu ?", price: 3000 },
    judging_en:    { name: "Judging in Dance", price: 2400 },
    unexpected_en: { name: "When the Unexpected Takes the Floor", price: 3000 },
  });

  const isEnglish = (document.documentElement.lang || "").toLowerCase().startsWith("en");
  const T = isEnglish ? {
    cart: "Your cart",
    close: "Close cart",
    empty: "Your cart is empty. Add a book from one of the catalogue pages.",
    shippingRule: "€3 delivery for book orders below €35; €0.01 from €35 of book purchases.",
    moreForThreshold: (x) => `Add ${x} more in books to reduce delivery to €0.01.`,
    belowThreshold: "Below €35, delivery is charged at €3.",
    thresholdReached: "€35 threshold reached.",
    shippingNow: "Delivery is €0.01 for this cart.",
    subtotal: "Books subtotal",
    shipping: "Delivery",
    total: "Total",
    removeOne: "Remove one copy",
    addOne: "Add one copy",
    qtyFor: (name) => `Quantity for ${name}`,
    remove: "Remove",
    checkout: "Proceed to checkout",
    opening: "Opening secure payment…",
    paymentError: "The payment page could not be created.",
    localError: "If you are viewing a local copy of the site, checkout can only be tested once the site is online at editions-perspectives.fr.",
    security: "The site sends only product references and quantities. Prices and delivery charges are recalculated on the server before Stripe Checkout opens.",
  } : {
    cart: "Votre panier",
    close: "Fermer le panier",
    empty: "Votre panier est vide. Ajoutez un livre depuis l’une des pages du catalogue.",
    shippingRule: "3 € de livraison pour un panier de livres inférieur à 35 € ; 0,01 € à partir de 35 € d’achats de livres.",
    moreForThreshold: (x) => `Encore ${x} de livres pour passer la livraison à 0,01 €.` ,
    belowThreshold: "En dessous de 35 €, la livraison est facturée 3 €.",
    thresholdReached: "Seuil de 35 € atteint.",
    shippingNow: "La livraison passe à 0,01 € pour ce panier.",
    subtotal: "Sous-total livres",
    shipping: "Livraison",
    total: "Total",
    removeOne: "Retirer un exemplaire",
    addOne: "Ajouter un exemplaire",
    qtyFor: (name) => `Quantité pour ${name}`,
    remove: "Retirer",
    checkout: "Passer commande",
    opening: "Ouverture du paiement…",
    paymentError: "Le paiement n’a pas pu être créé.",
    localError: "Si vous consultez une copie locale du site, le paiement ne peut être testé qu’après mise en ligne sur editions-perspectives.fr.",
    security: "Le site transmet uniquement les références et quantités. Les prix et les frais de livraison sont recalculés côté serveur avant l’ouverture du paiement sécurisé Stripe.",
  };

  const euros = (cents) => new Intl.NumberFormat(isEnglish ? "en-GB" : "fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);

  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const clean = {};
      Object.entries(raw).forEach(([id, qty]) => {
        const q = Number(qty);
        if (PRODUCTS[id] && Number.isInteger(q) && q > 0 && q <= 20) clean[id] = q;
      });
      return clean;
    } catch { return {}; }
  }

  function saveCart(cart) { localStorage.setItem(STORAGE_KEY, JSON.stringify(cart)); }
  function itemCount(cart) { return Object.values(cart).reduce((sum, qty) => sum + qty, 0); }
  function booksSubtotal(cart) { return Object.entries(cart).reduce((sum, [id, qty]) => sum + PRODUCTS[id].price * qty, 0); }
  function shippingFor(subtotal) { if (subtotal <= 0) return 0; return subtotal >= THRESHOLD_CENTS ? SHIPPING_HIGH_CENTS : SHIPPING_LOW_CENTS; }

  function ensureCartUi() {
    if (document.getElementById("ep-cart-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "ep-cart-overlay";
    overlay.className = "ep-cart-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <aside class="ep-cart-panel" role="dialog" aria-modal="true" aria-labelledby="ep-cart-title">
        <div class="ep-cart-head">
          <h2 id="ep-cart-title">${T.cart}</h2>
          <button type="button" class="ep-cart-close" aria-label="${T.close}">×</button>
        </div>
        <div id="ep-cart-items" class="ep-cart-items"></div>
        <div id="ep-cart-threshold" class="ep-cart-threshold"></div>
        <div id="ep-cart-summary" class="ep-cart-summary"></div>
        <button type="button" id="ep-cart-checkout" class="ep-cart-checkout">${T.checkout}</button>
        <div id="ep-cart-error" class="ep-cart-error" role="alert"></div>
        <p class="ep-cart-security">${T.security}</p>
      </aside>`;
    document.body.appendChild(overlay);
  }

  function renderCart() {
    ensureCartUi();
    const cart = loadCart();
    const count = itemCount(cart);
    document.querySelectorAll("[data-cart-count]").forEach((el) => { el.textContent = String(count); });

    const itemsEl = document.getElementById("ep-cart-items");
    const thresholdEl = document.getElementById("ep-cart-threshold");
    const summaryEl = document.getElementById("ep-cart-summary");
    const checkout = document.getElementById("ep-cart-checkout");
    const entries = Object.entries(cart);

    if (!entries.length) {
      itemsEl.innerHTML = `<div class="ep-cart-empty">${T.empty}</div>`;
      thresholdEl.innerHTML = `<strong>${isEnglish ? "Delivery" : "Livraison"}</strong>${T.shippingRule}`;
      summaryEl.innerHTML = "";
      checkout.disabled = true;
      return;
    }

    itemsEl.innerHTML = entries.map(([id, qty]) => {
      const product = PRODUCTS[id];
      return `<div class="ep-cart-item" data-cart-item="${id}">
        <div class="ep-cart-item-top"><div class="ep-cart-item-name">${product.name}</div><div class="ep-cart-item-price">${euros(product.price * qty)}</div></div>
        <div class="ep-cart-item-actions"><div class="ep-cart-qty" aria-label="${T.qtyFor(product.name)}">
          <button type="button" data-cart-dec="${id}" aria-label="${T.removeOne}">−</button><span>${qty}</span><button type="button" data-cart-inc="${id}" aria-label="${T.addOne}">+</button>
        </div><button type="button" class="ep-cart-remove" data-cart-remove="${id}">${T.remove}</button></div></div>`;
    }).join("");

    const subtotal = booksSubtotal(cart);
    const shipping = shippingFor(subtotal);
    const total = subtotal + shipping;

    if (subtotal < THRESHOLD_CENTS) {
      const remaining = THRESHOLD_CENTS - subtotal;
      thresholdEl.innerHTML = `<strong>${T.moreForThreshold(euros(remaining))}</strong>${T.belowThreshold}`;
    } else {
      thresholdEl.innerHTML = `<strong>${T.thresholdReached}</strong>${T.shippingNow}`;
    }

    summaryEl.innerHTML = `<div class="ep-cart-line"><span>${T.subtotal}</span><strong>${euros(subtotal)}</strong></div>
      <div class="ep-cart-line"><span>${T.shipping}</span><strong>${euros(shipping)}</strong></div>
      <div class="ep-cart-line total"><span>${T.total}</span><span>${euros(total)}</span></div>`;
    checkout.disabled = false;
  }

  function openCart() { renderCart(); const o=document.getElementById("ep-cart-overlay"); o.classList.add("is-open"); o.setAttribute("aria-hidden","false"); document.body.classList.add("ep-cart-lock"); const c=o.querySelector(".ep-cart-close"); if(c)c.focus(); }
  function closeCart() { const o=document.getElementById("ep-cart-overlay"); if(!o)return; o.classList.remove("is-open"); o.setAttribute("aria-hidden","true"); document.body.classList.remove("ep-cart-lock"); }
  function changeQty(id,delta){const c=loadCart(); const n=(c[id]||0)+delta; if(n<=0) delete c[id]; else c[id]=Math.min(n,20); saveCart(c); renderCart();}
  function addProduct(id){if(!PRODUCTS[id])return; const c=loadCart(); c[id]=Math.min((c[id]||0)+1,20); saveCart(c); renderCart(); openCart();}

  async function checkout(){
    const cart=loadCart(); const items=Object.entries(cart).map(([id,quantity])=>({id,quantity})); if(!items.length)return;
    const button=document.getElementById("ep-cart-checkout"), errorEl=document.getElementById("ep-cart-error");
    errorEl.classList.remove("is-visible"); errorEl.textContent=""; button.disabled=true; const oldText=button.textContent; button.textContent=T.opening;
    try{
      const response=await fetch(CHECKOUT_API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items})});
      const data=await response.json(); if(!response.ok||!data.url) throw new Error(data.error||T.paymentError); window.location.assign(data.url);
    }catch(error){errorEl.textContent=`${error.message} ${T.localError}`; errorEl.classList.add("is-visible"); button.disabled=false; button.textContent=oldText;}
  }

  document.addEventListener("click",(event)=>{
    const open=event.target.closest(".ep-cart-open"); if(open){event.preventDefault();openCart();return;}
    const add=event.target.closest("[data-cart-add]"); if(add){event.preventDefault();addProduct(add.getAttribute("data-cart-add"));return;}
    const close=event.target.closest(".ep-cart-close"); if(close){closeCart();return;}
    const inc=event.target.closest("[data-cart-inc]"); if(inc){changeQty(inc.getAttribute("data-cart-inc"),1);return;}
    const dec=event.target.closest("[data-cart-dec]"); if(dec){changeQty(dec.getAttribute("data-cart-dec"),-1);return;}
    const remove=event.target.closest("[data-cart-remove]"); if(remove){const c=loadCart(); delete c[remove.getAttribute("data-cart-remove")]; saveCart(c); renderCart();return;}
    if(event.target.id==="ep-cart-overlay")closeCart(); if(event.target.id==="ep-cart-checkout")checkout();
  });
  document.addEventListener("keydown",(event)=>{if(event.key==="Escape")closeCart();});
  window.addEventListener("storage",renderCart); document.addEventListener("DOMContentLoaded",renderCart);
})();
