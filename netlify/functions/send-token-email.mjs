import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const { sellerEmail, token, posts } = await req.json();

  if (!sellerEmail || !token || !posts) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: sellerEmail, token, posts' }),
      { status: 400 }
    );
  }

  try {
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: sellerEmail,
      subject: '✅ Your Deals-aholic Seller Token',
      html: `
        <div style="font-family: Inter, sans-serif; max-width: 500px; margin: 0 auto; background: #FAF8F4; padding: 24px; border-radius: 12px;">
          <h2 style="color: #1C1A17; margin-bottom: 16px;">🎉 Welcome to Deals-aholic Sellers!</h2>
          
          <p style="color: #6B6459; line-height: 1.6; margin-bottom: 20px;">
            Thank you for your purchase! Your seller token is ready to use.
          </p>
          
          <div style="background: #FFFFFF; border: 2px solid #FF8A1E; border-radius: 8px; padding: 16px; margin-bottom: 20px; text-align: center;">
            <p style="color: #6B6459; font-size: 12px; margin: 0 0 8px;">Your Seller Token</p>
            <p style="color: #FF8A1E; font-size: 20px; font-weight: 700; margin: 0; word-break: break-all;">
              ${token}
            </p>
            <p style="color: #6B6459; font-size: 12px; margin: 8px 0 0;">
              Valid for ${posts} deal${posts > 1 ? 's' : ''}
            </p>
          </div>
          
          <p style="color: #6B6459; line-height: 1.6; margin-bottom: 20px;">
            <strong>How to use your token:</strong><br>
            1. Go to <a href="https://deals-aholic.com/submit.html" style="color: #FF8A1E; text-decoration: none;">https://deals-aholic.com/submit.html</a><br>
            2. Fill in your deal information<br>
            3. Enter your token when prompted<br>
            4. Your deal will be posted instantly!
          </p>
          
          <p style="color: #6B6459; font-size: 12px; line-height: 1.6; margin-bottom: 0;">
            Questions? Reply to this email or visit our site.<br>
            <br>
            © 2025 Deals-aholic. All rights reserved.
          </p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    return new Response(
      JSON.stringify({ success: true, message: 'Token email sent successfully' }),
      { status: 200 }
    );
  } catch (error) {
    console.error('Email send error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to send email', details: error.message }),
      { status: 500 }
    );
  }
};
