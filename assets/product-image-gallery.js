import Swiper from 'swiper';
import { Pagination } from 'swiper/modules';

Swiper.use([Pagination]);

class ProductImageGallery extends HTMLElement {
  connectedCallback() {
    const swiperEl = this.querySelector('.swiper');
    if (!swiperEl || this.querySelectorAll('.swiper-slide').length <= 1) return;

    this._swiper = new Swiper(swiperEl, {
      modules: [Pagination],
      slidesPerView: 1,
      spaceBetween: 0,
      loop: false,
      pagination: {
        el: this.querySelector('.product-card-pagination'),
        clickable: true,
        bulletClass: 'bullet',
        bulletActiveClass: 'bullet-active',
        renderBullet: (_index, className) =>
          `<span class="tw-bg-secondary-100 [&.bullet-active]:tw-bg-brand-black tw-block tw-h-[6px] tw-w-[6px] tw-rounded-full ${className}"></span>`,
      },
    });

    this._card = this.closest('.product-card');
    if (this._card) {
      this._onEnter = () => this._swiper?.slideNext();
      this._onLeave = () => this._swiper?.slideTo(0);
      this._card.addEventListener('mouseenter', this._onEnter);
      this._card.addEventListener('mouseleave', this._onLeave);
    }
  }

  disconnectedCallback() {
    if (this._card) {
      this._card.removeEventListener('mouseenter', this._onEnter);
      this._card.removeEventListener('mouseleave', this._onLeave);
    }
    this._swiper?.destroy(true, true);
    this._swiper = null;
  }
}

if (!customElements.get('product-image-gallery')) {
  customElements.define('product-image-gallery', ProductImageGallery);
}
