<?php
/**
 * Plugin Name: IntroLinq
 * Plugin URI:  https://www.introlinq.com
 * Description: Connect your readers with bookable experts — automatically. Paste your Publisher ID below and the widget activates on every article.
 * Version:     1.0.0
 * Author:      IntroLinq
 * Author URI:  https://www.introlinq.com
 * License:     GPL-2.0+
 * Text Domain: introlinq
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// Settings page in WP admin
add_action( 'admin_menu', function () {
    add_options_page(
        'IntroLinq',
        'IntroLinq',
        'manage_options',
        'introlinq',
        'introlinq_settings_page'
    );
} );

add_action( 'admin_init', function () {
    register_setting( 'introlinq', 'introlinq_publisher_id', [
        'sanitize_callback' => 'sanitize_text_field',
    ] );
} );

function introlinq_settings_page() {
    $pub = get_option( 'introlinq_publisher_id', '' );
    ?>
    <div class="wrap">
        <h1 style="display:flex;align-items:center;gap:10px">
            <span style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em">Intro<span style="color:#e6a820">Linq</span></span>
        </h1>
        <p style="color:#666;margin-top:4px;margin-bottom:24px">Connect your readers with bookable experts. <a href="https://www.introlinq.com/dashboard" target="_blank">View your dashboard →</a></p>

        <form method="post" action="options.php">
            <?php settings_fields( 'introlinq' ); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row">
                        <label for="introlinq_publisher_id">Publisher ID</label>
                    </th>
                    <td>
                        <input
                            type="text"
                            id="introlinq_publisher_id"
                            name="introlinq_publisher_id"
                            value="<?php echo esc_attr( $pub ); ?>"
                            class="regular-text"
                            placeholder="your-publication"
                        >
                        <p class="description">
                            Find your Publisher ID in your <a href="https://www.introlinq.com/dashboard" target="_blank">IntroLinq dashboard</a> under the Widget tab.
                        </p>
                    </td>
                </tr>
            </table>
            <?php submit_button( 'Save Publisher ID' ); ?>
        </form>

        <?php if ( $pub ) : ?>
        <hr>
        <h2 style="font-size:1rem;margin-bottom:8px">Your embed code</h2>
        <code style="display:block;background:#edf5f0;color:#3d7a5f;padding:12px 16px;border-radius:6px;font-size:13px">
            &lt;script src="https://www.introlinq.com/widget.js" data-publisher="<?php echo esc_attr( $pub ); ?>"&gt;&lt;/script&gt;
        </code>
        <p class="description" style="margin-top:8px">This is already being injected automatically by the plugin — no action needed.</p>
        <?php endif; ?>
    </div>
    <?php
}

// Inject widget script in footer on all pages
add_action( 'wp_footer', function () {
    $pub = get_option( 'introlinq_publisher_id', '' );
    if ( ! $pub ) return;
    echo '<script src="https://www.introlinq.com/widget.js" data-publisher="' . esc_attr( $pub ) . '"></script>' . "\n";
} );
